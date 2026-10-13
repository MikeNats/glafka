import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDir } from '../helpers/tempDir.js';
import {
  appendRunRecord,
  readRunRecords,
  recordPath,
  AUDIT_STAGES,
  type RunRecord,
} from '../../src/audit/record.js';
import { publishAudit } from '../../src/audit/publish.js';
import { auditPath } from '../../src/ticket/paths.js';
import { ROLES } from '../../src/types/ticket.js';
import {
  writeTicket,
  archiveClosedTicket,
  recordStage,
  STAGES,
} from '../../src/ticket/ticketStore.js';

const ID = '2026-08-07-add-dark-mode';

function aRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    at: '2026-08-07T10:11:30.123Z',
    kind: 'run',
    stage: AUDIT_STAGES.ERGON,
    role: ROLES.CODER,
    agent: 'claude',
    durationMs: 638000,
    exitCode: 0,
    promptBytes: 48213,
    responseBytes: 6210,
    tokens: { in: 48000, out: 6200 },
    tokenSource: 'claude-json',
    ...overrides,
  };
}

test('a record is appended and read back whole', () => {
  const stateDir = makeTempDir('rec');

  appendRunRecord(stateDir, ID, aRecord());
  appendRunRecord(stateDir, ID, aRecord({ role: ROLES.REVIEWER, durationMs: 1000 }));

  const back = readRunRecords(stateDir, ID);
  assert.equal(back.length, 2);
  assert.equal(back[0]!.role, 'coder');
  assert.equal(back[1]!.durationMs, 1000);
  assert.deepEqual(back[0]!.tokens, { in: 48000, out: 6200 });
});

// null is "we did not measure". It must survive the round trip as null.
test('unmeasured fields round-trip as null, not as zero', () => {
  const stateDir = makeTempDir('rec');
  appendRunRecord(stateDir, ID, aRecord({ tokens: null, tokenSource: null, responseBytes: null }));

  const [back] = readRunRecords(stateDir, ID);
  assert.equal(back!.tokens, null);
  assert.equal(back!.responseBytes, null);
});

test('a repo-level run with no ticket is still recorded', () => {
  const stateDir = makeTempDir('rec');
  appendRunRecord(stateDir, null, aRecord({ stage: AUDIT_STAGES.ODYSSE, role: ROLES.REPORTER }));

  assert.equal(readRunRecords(stateDir, null).length, 1);
  assert.match(recordPath(stateDir, null), /no-ticket/);
});

// THE POINT OF THE WHOLE TASK. archiveClosedTicket deletes runsDir; the
// record has to be somewhere that instead moves with the ticket.
test('the record survives closing the ticket', () => {
  const stateDir = makeTempDir('rec');
  const now = '2026-08-07T00:00:00.000Z';
  writeTicket(stateDir, { id: ID, created: now, updated: now });
  appendRunRecord(stateDir, ID, aRecord());

  archiveClosedTicket(stateDir, ID);

  assert.equal(readRunRecords(stateDir, ID).length, 1);
  assert.match(recordPath(stateDir, ID), /closed/);
});

// The git copy is the ONLY audit that survives the state directory, and for
// months it held run rows alone — so the whole spec-and-plan half of a ticket,
// which starts no process, was invisible in the one file people actually read.
test('the published audit carries the stage log, not only the runs', () => {
  const stateDir = makeTempDir('rec');
  const repoRoot = makeTempDir('rec-repo');
  const now = '2026-08-07T00:00:00.000Z';
  writeTicket(stateDir, { id: ID, created: now, updated: now });
  recordStage(stateDir, ID, STAGES.CREATE);
  recordStage(stateDir, ID, STAGES.SPEC);
  // recordStage stamps the row with the real clock, so the run has to be
  // dated after it or the merge is being tested against the wrong order.
  appendRunRecord(stateDir, ID, aRecord({ at: '2099-01-01T00:00:00.000Z' }));

  const written = publishAudit({ repoRoot, stateDir, ticketId: ID });

  assert.equal(written, auditPath(repoRoot, ID));
  const rows = fs
    .readFileSync(written!, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { kind: string; stage: string });
  assert.deepEqual(
    rows.map((row) => `${row.kind}:${row.stage}`),
    ['stage:create', 'stage:spec', 'run:ergon'],
  );
});

// A ticket abandoned before its first agent run still has a history, and it is
// exactly the history someone asks for later: how far did this get?
test('a ticket with stages but no runs still publishes', () => {
  const stateDir = makeTempDir('rec');
  const repoRoot = makeTempDir('rec-repo');
  const now = '2026-08-07T00:00:00.000Z';
  writeTicket(stateDir, { id: ID, created: now, updated: now });
  recordStage(stateDir, ID, STAGES.CREATE);

  const written = publishAudit({ repoRoot, stateDir, ticketId: ID });

  assert.notEqual(written, null);
  assert.match(fs.readFileSync(written!, 'utf8'), /"kind":"stage"/);
});

test('a ticket that recorded nothing at all publishes nothing', () => {
  const stateDir = makeTempDir('rec');
  const repoRoot = makeTempDir('rec-repo');

  assert.equal(publishAudit({ repoRoot, stateDir, ticketId: ID }), null);
  assert.equal(fs.existsSync(auditPath(repoRoot, ID)), false);
});

// A push must never fail because a log line could not be written.
test('an unwritable record does not throw', () => {
  const stateDir = makeTempDir('rec');
  // A file where the directory needs to be.
  fs.mkdirSync(path.dirname(recordPath(stateDir, ID)), { recursive: true });
  fs.writeFileSync(recordPath(stateDir, ID), '');
  fs.chmodSync(recordPath(stateDir, ID), 0o444);

  assert.doesNotThrow(() => appendRunRecord(stateDir, ID, aRecord()));
});

test('a mangled line is skipped rather than crashing the reader', () => {
  const stateDir = makeTempDir('rec');
  appendRunRecord(stateDir, ID, aRecord());
  fs.appendFileSync(recordPath(stateDir, ID), 'not json\n');
  appendRunRecord(stateDir, ID, aRecord({ role: ROLES.REVIEWER }));

  assert.equal(readRunRecords(stateDir, ID).length, 2);
});

// Parseable is not the same as valid. A truncated write or a hand edit
// leaves JSON with no `at`, and sorting on that threw for the whole command.
test('a line that parses but is not a record is skipped, not returned', () => {
  const stateDir = makeTempDir('rec');
  appendRunRecord(stateDir, ID, aRecord());
  fs.appendFileSync(recordPath(stateDir, ID), '{"hello":"world"}\n');
  fs.appendFileSync(recordPath(stateDir, ID), '{"kind":"run"}\n');
  fs.appendFileSync(recordPath(stateDir, ID), '{"kind":"run","at":"not-a-date","durationMs":1}\n');
  appendRunRecord(stateDir, ID, aRecord({ role: ROLES.REVIEWER }));

  const back = readRunRecords(stateDir, ID);

  assert.equal(back.length, 2);
  assert.deepEqual(
    back.map((r) => r.role),
    [ROLES.CODER, ROLES.REVIEWER],
  );
});
