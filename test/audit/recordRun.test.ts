import { test } from 'node:test';
import { markOutcomeRecorded } from '../../src/ticket/background.js';
import {
  hasRecordedOutcome,
  markExternalRunStarted,
  markExternalRunFinished,
} from '../../src/ticket/background.js';
import { runRolesOnDisk } from '../../src/ticket/paths.js';
import { archiveClosedTicket } from '../../src/ticket/ticketStore.js';
import { writeTicket } from '../../src/ticket/ticketStore.js';
import { ergonReviewStatus } from '../../src/commands/ergon/ergon.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeTempDir } from '../helpers/tempDir.js';
import { startRun, recordBackgroundRun, recordHandover } from '../../src/audit/recordRun.js';
import { readRunRecords, recordPath } from '../../src/audit/record.js';
import { runFiles } from '../../src/ticket/paths.js';

const ID = '2026-08-07-add-dark-mode';

function begin(stateDir: string | null, enabled = true) {
  return startRun({
    stateDir,
    ticketId: ID,
    stage: 'ergon',
    role: 'coder',
    agentCmd: 'claude -p --permission-mode acceptEdits',
    promptBytes: 1234,
    enabled,
  });
}

test('a finished run is recorded with what we measured', () => {
  const stateDir = makeTempDir('run');
  const usage = JSON.stringify({ usage: { input_tokens: 900, output_tokens: 30 } });

  begin(stateDir).finish({ exitCode: 0, output: usage });

  const [rec] = readRunRecords(stateDir, ID);
  assert.equal(rec!.role, 'coder');
  assert.equal(rec!.agent, 'claude');
  assert.equal(rec!.exitCode, 0);
  assert.equal(rec!.promptBytes, 1234);
  assert.deepEqual(rec!.tokens, { in: 900, out: 30 });
  assert.equal(rec!.responseBytes, Buffer.byteLength(usage));
  assert.ok(rec!.durationMs !== null && rec!.durationMs >= 0);
});

// The deliverPrompt case: we never saw the output, so we know neither the
// token count nor the size. Both null; the fields we DO hold stay set.
test('output we never saw leaves tokens and size null, not zero', () => {
  const stateDir = makeTempDir('run');

  begin(stateDir).finish({ exitCode: 0, output: null });

  const [rec] = readRunRecords(stateDir, ID);
  assert.equal(rec!.tokens, null);
  assert.equal(rec!.tokenSource, null);
  assert.equal(rec!.responseBytes, null);
  assert.equal(rec!.promptBytes, 1234);
  assert.equal(rec!.exitCode, 0);
});

test('a crashed run records its exit code', () => {
  const stateDir = makeTempDir('run');

  begin(stateDir).finish({ exitCode: null, output: null });

  assert.equal(readRunRecords(stateDir, ID)[0]!.exitCode, null);
});

test('disabled writes nothing at all', () => {
  const stateDir = makeTempDir('run');

  begin(stateDir, false).finish({ exitCode: 0, output: '{}' });

  assert.equal(fs.existsSync(recordPath(stateDir, ID)), false);
});

// Some callers have no stateDir to write into. That is not an error.
test('no stateDir writes nothing and does not throw', () => {
  assert.doesNotThrow(() => begin(null).finish({ exitCode: 0, output: null }));
});

// recordBackgroundRun: the finish side of a background run, read off disk
// because the process that spawned it is gone by the time this runs.

function writeRunFiles(
  stateDir: string,
  id: string,
  role: string,
  {
    agent = 'claude',
    prompt = 'do the thing',
    log,
    startedAt,
    exitCode,
  }: {
    agent?: string | null;
    prompt?: string | null;
    log?: string | null;
    startedAt?: number | null;
    exitCode?: number | null;
  } = {},
): void {
  const files = runFiles(stateDir, id, role);
  fs.mkdirSync(files.dir, { recursive: true });
  if (agent !== null) fs.writeFileSync(files.agentPath, agent);
  if (prompt !== null) fs.writeFileSync(files.promptPath, prompt);
  if (log !== null) fs.writeFileSync(files.logPath, log ?? '');
  // spawnBackground writes this with String(Date.now()) — a plain
  // millisecond number, not an ISO string.
  if (startedAt !== null) fs.writeFileSync(files.startedAtPath, String(startedAt));
  if (exitCode !== null) fs.writeFileSync(files.exitCodePath, String(exitCode));
}

test('a finished background run is reconstructed from what is on disk', () => {
  const stateDir = makeTempDir('run');
  const startedAt = Date.now() - 5000;
  const usage = JSON.stringify({ usage: { input_tokens: 500, output_tokens: 40 } });
  writeRunFiles(stateDir, ID, 'coder', { agent: 'claude', log: usage, startedAt, exitCode: 0 });

  recordBackgroundRun({ stateDir, ticketId: ID, role: 'coder', enabled: true });

  const [rec] = readRunRecords(stateDir, ID);
  assert.equal(rec!.stage, 'ergon');
  assert.equal(rec!.role, 'coder');
  assert.equal(rec!.agent, 'claude');
  assert.equal(rec!.exitCode, 0);
  assert.equal(rec!.at, new Date(startedAt).toISOString());
  assert.ok(rec!.durationMs! >= 5000);
  assert.deepEqual(rec!.tokens, { in: 500, out: 40 });
  assert.equal(rec!.responseBytes, Buffer.byteLength(usage));
});

// A reviewer's outcome is filed under 'review', not 'ergon'.
test('a reviewer run is filed under the review stage', () => {
  const stateDir = makeTempDir('run');
  writeRunFiles(stateDir, ID, 'reviewer', { startedAt: Date.now(), exitCode: 0 });

  recordBackgroundRun({ stateDir, ticketId: ID, role: 'reviewer', enabled: true });

  assert.equal(readRunRecords(stateDir, ID)[0]!.stage, 'review');
});

// M4: a QA tester's outcome has its own stage, so the audit can tell it from a review.
test('a verifier run is filed under the verify stage', () => {
  const stateDir = makeTempDir('run');
  writeRunFiles(stateDir, ID, 'verifier', { startedAt: Date.now(), exitCode: 0 });

  recordBackgroundRun({ stateDir, ticketId: ID, role: 'verifier', enabled: true });

  assert.equal(readRunRecords(stateDir, ID)[0]!.stage, 'verify');
});

// A run killed before it wrote its exit code has none — that is not the same
// as having exited 0, and Number('') would say otherwise.
test('a missing exit code is recorded as null, never as a false zero', () => {
  const stateDir = makeTempDir('run');
  writeRunFiles(stateDir, ID, 'coder', { startedAt: Date.now(), exitCode: null });

  recordBackgroundRun({ stateDir, ticketId: ID, role: 'coder', enabled: true });

  assert.equal(readRunRecords(stateDir, ID)[0]!.exitCode, null);
});

// archiveClosedTicket reaps the runs/ folder on close. If recordBackgroundRun
// runs after that, there is no log left to read — not an empty one.
test('a reaped log is recorded as unmeasured, not as empty', () => {
  const stateDir = makeTempDir('run');
  writeRunFiles(stateDir, ID, 'coder', { log: null, startedAt: Date.now(), exitCode: 0 });

  recordBackgroundRun({ stateDir, ticketId: ID, role: 'coder', enabled: true });

  const [rec] = readRunRecords(stateDir, ID);
  assert.equal(rec!.responseBytes, null);
  assert.equal(rec!.tokens, null);
});

test('no agent file on disk records "unknown" rather than throwing', () => {
  const stateDir = makeTempDir('run');
  writeRunFiles(stateDir, ID, 'coder', { agent: null, startedAt: Date.now(), exitCode: 0 });

  recordBackgroundRun({ stateDir, ticketId: ID, role: 'coder', enabled: true });

  assert.equal(readRunRecords(stateDir, ID)[0]!.agent, 'unknown');
});

test('disabled records nothing for a background run either', () => {
  const stateDir = makeTempDir('run');
  writeRunFiles(stateDir, ID, 'coder', { startedAt: Date.now(), exitCode: 0 });

  recordBackgroundRun({ stateDir, ticketId: ID, role: 'coder', enabled: false });

  assert.equal(fs.existsSync(recordPath(stateDir, ID)), false);
});

// Reviewers are spawned in the background and their outcome is observed only
// by ergonReviewStatus. Nothing recorded them, so fan-out review spend —
// often most of a ticket's cost — was invisible.
test('every reviewer run is recorded, once, however often status is asked', () => {
  const stateDir = makeTempDir('rev');
  const id = '2026-08-07-add-dark-mode';
  const now = new Date().toISOString();
  writeTicket(stateDir, {
    id,
    created: now,
    updated: now,
    reviewerRoles: ['reviewer', 'reviewer-1'],
  } as never);

  for (const role of ['reviewer', 'reviewer-1']) {
    const f = runFiles(stateDir, id, role);
    fs.mkdirSync(f.dir, { recursive: true });
    fs.writeFileSync(f.startedAtPath, String(Date.now() - 9000));
    fs.writeFileSync(f.exitCodePath, '0');
    fs.writeFileSync(f.promptPath, 'p');
    fs.writeFileSync(f.agentPath, 'claude');
    fs.writeFileSync(f.logPath, '{"usage":{"input_tokens":500,"output_tokens":40}}\n');
  }

  for (let i = 0; i < 3; i += 1) ergonReviewStatus({ stateDir, id, observability: true });

  const records = readRunRecords(stateDir, id);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((r) => r.role).sort(), ['reviewer', 'reviewer-1']);
  assert.deepEqual(
    records.map((r) => r.stage),
    ['review', 'review'],
  );
});

// A background run's record is written whenever someone next asks for
// status, which can be hours after the run actually ended. Measuring to
// "now" made a 10-minute coder run read as an overnight one.
test('a background run measures how long it ran, not how long until we looked', () => {
  const stateDir = makeTempDir('dur');
  const id = '2026-08-07-add-dark-mode';
  const f = runFiles(stateDir, id, 'coder');
  fs.mkdirSync(f.dir, { recursive: true });

  const startedAt = Date.now() - 8 * 3600_000;
  const endedAt = startedAt + 10 * 60_000;
  fs.writeFileSync(f.startedAtPath, String(startedAt));
  fs.writeFileSync(f.exitCodePath, '0');
  fs.utimesSync(f.exitCodePath, endedAt / 1000, endedAt / 1000);
  fs.writeFileSync(f.promptPath, 'p');
  fs.writeFileSync(f.agentPath, 'claude');
  fs.writeFileSync(f.logPath, '');

  recordBackgroundRun({ stateDir, ticketId: id, role: 'coder', enabled: true });

  const [rec] = readRunRecords(stateDir, id);
  assert.ok(
    Math.abs(rec!.durationMs! - 10 * 60_000) < 2000,
    `expected about 10 minutes, got ${rec!.durationMs}ms`,
  );
});

// poreia and epistle peek at review status with no config, so observability
// is off there. markOutcomeRecorded writes its marker either way, so an
// unguarded call burned it and the run could never be recorded afterwards.
test('a read-only status peek does not stop the run being recorded later', () => {
  const stateDir = makeTempDir('peek');
  const id = '2026-08-07-add-dark-mode';
  const now = new Date().toISOString();
  writeTicket(stateDir, { id, created: now, updated: now, reviewerRoles: ['reviewer'] } as never);
  const f = runFiles(stateDir, id, 'reviewer');
  fs.mkdirSync(f.dir, { recursive: true });
  fs.writeFileSync(f.startedAtPath, String(Date.now() - 60_000));
  fs.writeFileSync(f.exitCodePath, '0');
  fs.writeFileSync(f.promptPath, 'p');
  fs.writeFileSync(f.agentPath, 'claude');
  fs.writeFileSync(f.logPath, '');

  ergonReviewStatus({ stateDir, id });
  assert.equal(readRunRecords(stateDir, id).length, 0, 'a peek must record nothing');

  ergonReviewStatus({ stateDir, id, observability: true });
  assert.equal(readRunRecords(stateDir, id).length, 1, 'the peek burned the marker');
});

// A run killed at its timeout never writes an exit code, so the end time had
// to come from somewhere else — otherwise the fix for "duration measured the
// wait" silently did not apply to the runs that cost the most.
test('a killed run measures to its last output, not to now', () => {
  const stateDir = makeTempDir('killed');
  const id = '2026-08-07-add-dark-mode';
  const f = runFiles(stateDir, id, 'coder');
  fs.mkdirSync(f.dir, { recursive: true });

  const startedAt = Date.now() - 6 * 3600_000;
  const killedAt = startedAt + 60 * 60_000;
  fs.writeFileSync(f.startedAtPath, String(startedAt));
  fs.writeFileSync(f.promptPath, 'p');
  fs.writeFileSync(f.agentPath, 'claude');
  fs.writeFileSync(f.logPath, 'last output before the kill\n');
  fs.utimesSync(f.logPath, killedAt / 1000, killedAt / 1000);

  recordBackgroundRun({ stateDir, ticketId: id, role: 'coder', enabled: true });

  const [rec] = readRunRecords(stateDir, id);
  assert.ok(
    Math.abs(rec!.durationMs! - 60 * 60_000) < 2000,
    `expected about 60 minutes, got ${rec!.durationMs}ms`,
  );
  assert.equal(rec!.exitCode, null);
});

// The third instance of the rule this feature rests on, flagged by a Task 5
// reviewer and left unactioned: a run whose start we never read is not a run
// that took no time, and a prompt we cannot size is not an empty one.
test('a run with unreadable files records null, not zero', () => {
  const stateDir = makeTempDir('unk');
  const id = '2026-08-07-add-dark-mode';
  const f = runFiles(stateDir, id, 'coder');
  fs.mkdirSync(f.dir, { recursive: true });
  fs.writeFileSync(f.agentPath, 'claude');
  // No started-at, no prompt, no exit code.

  recordBackgroundRun({ stateDir, ticketId: id, role: 'coder', enabled: true });

  const [rec] = readRunRecords(stateDir, id);
  assert.equal(rec!.durationMs, null);
  assert.equal(rec!.promptBytes, null);
  assert.equal(rec!.exitCode, null);
});

// Closing a ticket deletes runsDir, so it is the last moment an unobserved
// run can be recorded. A manual flow that never asks for status lost every
// run permanently at close.
test('closing a ticket records the runs nobody asked the status of', () => {
  const stateDir = makeTempDir('close');
  const id = '2026-08-07-add-dark-mode';
  const now = new Date().toISOString();
  writeTicket(stateDir, { id, created: now, updated: now } as never);

  for (const role of ['coder', 'reviewer']) {
    const f = runFiles(stateDir, id, role);
    fs.mkdirSync(f.dir, { recursive: true });
    fs.writeFileSync(f.startedAtPath, String(Date.now() - 120_000));
    fs.writeFileSync(f.exitCodePath, '0');
    fs.writeFileSync(f.promptPath, 'p');
    fs.writeFileSync(f.agentPath, 'claude');
    fs.writeFileSync(
      f.logPath,
      '{"type":"result","usage":{"input_tokens":900,"output_tokens":30}}',
    );
  }

  for (const role of runRolesOnDisk(stateDir, id)) {
    if (!hasRecordedOutcome({ stateDir, id, role })) {
      markOutcomeRecorded({ stateDir, id, role, observability: true });
    }
  }
  archiveClosedTicket(stateDir, id);

  const records = readRunRecords(stateDir, id);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((r) => r.role).sort(), ['coder', 'reviewer']);
});

// The exit code for a run glafka did not spawn is glafka's own guess: nothing
// reported it. Recording that 0 as a measurement said "the agent finished
// clean" about runs nobody ever watched exit.
test('an exit code glafka assumed is recorded as not measured', () => {
  const stateDir = makeTempDir('assumed');
  const f = runFiles(stateDir, ID, 'coder');

  markExternalRunStarted({ stateDir, id: ID, role: 'coder', prompt: 'hello' });
  markExternalRunFinished({ stateDir, id: ID, role: 'coder' });
  recordBackgroundRun({ stateDir, ticketId: ID, role: 'coder', enabled: true });

  // The file itself still says 0 — the liveness check needs it.
  assert.equal(fs.readFileSync(f.exitCodePath, 'utf8'), '0');
  const [rec] = readRunRecords(stateDir, ID);
  assert.equal(rec!.exitCode, null);
});

test('a run glafka spawned keeps its real exit code', () => {
  const stateDir = makeTempDir('real');
  const f = runFiles(stateDir, ID, 'coder');
  fs.mkdirSync(f.dir, { recursive: true });
  fs.writeFileSync(f.startedAtPath, String(Date.now() - 1000));
  fs.writeFileSync(f.exitCodePath, '2');

  recordBackgroundRun({ stateDir, ticketId: ID, role: 'coder', enabled: true });

  const [rec] = readRunRecords(stateDir, ID);
  assert.equal(rec!.exitCode, 2);
});

// The prompt was handed to the session, so no process ran and there is no
// agent name to read. It said "unknown" and sized the prompt as null.
test('a run handed to the session saves what it handed out', () => {
  const stateDir = makeTempDir('handout');
  const f = runFiles(stateDir, ID, 'coder');

  markExternalRunStarted({ stateDir, id: ID, role: 'coder', prompt: 'hello agent' });
  recordBackgroundRun({ stateDir, ticketId: ID, role: 'coder', enabled: true });

  assert.equal(fs.readFileSync(f.agentPath, 'utf8'), 'session');
  const [rec] = readRunRecords(stateDir, ID);
  assert.equal(rec!.agent, 'session');
  assert.equal(rec!.promptBytes, Buffer.byteLength('hello agent'));
});

test('a run handed to a named agent saves that agent', () => {
  const stateDir = makeTempDir('named');

  markExternalRunStarted({
    stateDir,
    id: ID,
    role: 'coder',
    prompt: 'hello',
    agentCmd: 'claude -p --permission-mode acceptEdits',
  });
  recordBackgroundRun({ stateDir, ticketId: ID, role: 'coder', enabled: true });

  const [rec] = readRunRecords(stateDir, ID);
  assert.equal(rec!.agent, 'claude');
});

// A prompt printed for the session to carry out is the whole brainstorm-and-
// plan half of a ticket. Nothing spawns, so nothing ever recorded it.
test('a prompt handed to the session is recorded', () => {
  const stateDir = makeTempDir('handover');

  recordHandover({
    stateDir,
    ticketId: ID,
    stage: 'genesis',
    role: 'reporter',
    promptBytes: 4096,
    enabled: true,
  });

  const [rec] = readRunRecords(stateDir, ID);
  assert.equal(rec!.stage, 'genesis');
  assert.equal(rec!.agent, 'session');
  assert.equal(rec!.promptBytes, 4096);
  assert.equal(rec!.durationMs, null);
  assert.equal(rec!.exitCode, null);
  assert.equal(rec!.responseBytes, null);
  assert.equal(rec!.tokens, null);
});

// The close records this one off its run files, which know the duration and
// the log. Two rows for one run is worse than the weaker of the two.
test('a handover is not recorded twice when run files already follow it', () => {
  const stateDir = makeTempDir('twice');

  markExternalRunStarted({ stateDir, id: ID, role: 'coder', prompt: 'hello' });
  recordHandover({
    stateDir,
    ticketId: ID,
    stage: 'ergon',
    role: 'coder',
    promptBytes: 5,
    enabled: true,
  });

  assert.equal(readRunRecords(stateDir, ID).length, 0);
});

// Same rule from the other side: this row IS the run's ending, so the close
// must leave it alone rather than write a second, weaker one.
test('a live run that records itself is not recorded again at close', () => {
  const stateDir = makeTempDir('marked');

  markExternalRunStarted({ stateDir, id: ID, role: 'coder', prompt: 'hello' });
  begin(stateDir).finish({ exitCode: 0, output: null });

  assert.equal(hasRecordedOutcome({ stateDir, id: ID, role: 'coder' }), true);
  assert.equal(readRunRecords(stateDir, ID).length, 1);
});
