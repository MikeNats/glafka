import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDir } from '../helpers/tempDir.js';
import { appendRunRecord, AUDIT_STAGES, type RunRecord } from '../../src/audit/record.js';
import { ROLES } from '../../src/types/ticket.js';
import { readAudit, readAuditSummary } from '../../src/audit/read.js';
import { resolvePolicy } from '../../installKit/guardrails/index.js';
import { writeTicket, archiveClosedTicket } from '../../src/ticket/ticketStore.js';

const ID = '2026-08-07-add-dark-mode';
const OTHER = '2026-08-07-fix-login-bypass';

// Turns guardrails audit genuinely on via a real project policy file, the
// same way a live repo would — so resolvePolicy does the real work.
function enableGuardrailsAudit(repoRoot: string): void {
  fs.mkdirSync(path.join(repoRoot, 'docs', 'glafka'), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, 'docs', 'glafka', 'guardrails.json'),
    JSON.stringify({ level: 1 }),
  );
}

function run(at: string, overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    at,
    kind: 'run',
    stage: AUDIT_STAGES.ERGON,
    role: ROLES.CODER,
    agent: 'claude',
    durationMs: 1000,
    exitCode: 0,
    promptBytes: 10,
    responseBytes: 5,
    tokens: { in: 100, out: 20 },
    tokenSource: 'claude-json',
    ...overrides,
  };
}

test('events come back in timestamp order regardless of file order', () => {
  const stateDir = makeTempDir('read');
  const repoRoot = makeTempDir('repo');
  appendRunRecord(stateDir, ID, run('2026-08-07T10:05:00.000Z', { role: ROLES.REVIEWER }));
  appendRunRecord(stateDir, ID, run('2026-08-07T10:01:00.000Z'));

  const report = readAudit({ stateDir, repoRoot, ticketId: ID });

  assert.deepEqual(
    report.events.map((e) => e.at),
    ['2026-08-07T10:01:00.000Z', '2026-08-07T10:05:00.000Z'],
  );
});

test('totals add up across runs', () => {
  const stateDir = makeTempDir('read');
  const repoRoot = makeTempDir('repo');
  appendRunRecord(stateDir, ID, run('2026-08-07T10:01:00.000Z'));
  appendRunRecord(stateDir, ID, run('2026-08-07T10:05:00.000Z', { durationMs: 500 }));

  const { totals } = readAudit({ stateDir, repoRoot, ticketId: ID });

  assert.equal(totals.runs, 2);
  assert.equal(totals.durationMs, 1500);
  assert.equal(totals.tokensIn, 200);
  assert.equal(totals.tokensOut, 40);
});

// THE POINT. Absence of data must never look like data showing absence.
test('tools is false when guardrails never watched', () => {
  const stateDir = makeTempDir('read');
  const repoRoot = makeTempDir('repo');
  appendRunRecord(stateDir, ID, run('2026-08-07T10:01:00.000Z'));

  const report = readAudit({ stateDir, repoRoot, ticketId: ID });

  assert.equal(report.sources.tools, false);
  assert.equal(
    report.events.some((e) => e.kind === 'tool'),
    false,
  );
});

// THE POINT, the other direction. sources.tools must come from the policy
// flag, never from list length — else an empty list reads as "not watched".
test('sources.tools is true when guardrails watched and genuinely saw nothing', () => {
  const stateDir = makeTempDir('read');
  const repoRoot = makeTempDir('repo');
  enableGuardrailsAudit(repoRoot);
  appendRunRecord(stateDir, ID, run('2026-08-07T10:01:00.000Z'));

  const report = readAudit({ stateDir, repoRoot, ticketId: ID });

  assert.equal(report.sources.tools, true);
  assert.equal(
    report.events.some((e) => e.kind === 'tool'),
    false,
  );
});

// Pins the $stateDir/$ticketId expansion: the .1 file must be checked at
// the exact path guardrails' own writer would roll it to, both tokens.
test('toolsPartial flips true only once a .1 file exists at the real expanded path', () => {
  const stateDir = makeTempDir('read');
  const repoRoot = makeTempDir('repo');
  enableGuardrailsAudit(repoRoot);

  const before = readAudit({ stateDir, repoRoot, ticketId: ID });
  assert.equal(before.toolsPartial, false);

  const { policy } = resolvePolicy({ repoRoot });
  const toolLogPath = policy.audit.path.replace('$stateDir', stateDir).replace('$ticketId', ID);
  fs.mkdirSync(path.dirname(toolLogPath), { recursive: true });
  fs.writeFileSync(`${toolLogPath}.1`, '');

  const after = readAudit({ stateDir, repoRoot, ticketId: ID });
  assert.equal(after.toolsPartial, true);
});

// Unmeasured tokens must not be summed as zero-that-counts.
// It used to total 0 here, which reads as a free run rather than an
// unmeasured one. The run itself still counts.
test('a run with null tokens counts as a run, but not as zero tokens', () => {
  const stateDir = makeTempDir('read');
  const repoRoot = makeTempDir('repo');
  appendRunRecord(
    stateDir,
    ID,
    run('2026-08-07T10:01:00.000Z', { tokens: null, tokenSource: null }),
  );

  const { totals } = readAudit({ stateDir, repoRoot, ticketId: ID });

  assert.equal(totals.runs, 1);
  assert.equal(totals.tokensIn, null);
});

test('a ticket with nothing recorded reports empty, not an error', () => {
  const report = readAudit({
    stateDir: makeTempDir('read'),
    repoRoot: makeTempDir('repo'),
    ticketId: ID,
  });

  assert.deepEqual(report.events, []);
  assert.equal(report.sources.runs, false);
  assert.equal(report.schema, 3);
});

// THE POINT: a closed ticket's record lives under tickets/closed/, not
// tickets/ — the summary must still find it there.
test('every ticket with a record appears, open or closed', () => {
  const stateDir = makeTempDir('sum');
  const repoRoot = makeTempDir('repo');
  const now = '2026-08-07T00:00:00.000Z';
  writeTicket(stateDir, { id: OTHER, created: now, updated: now });
  appendRunRecord(stateDir, ID, run('2026-08-07T10:01:00.000Z'));
  appendRunRecord(stateDir, OTHER, run('2026-08-07T11:01:00.000Z', { role: ROLES.REVIEWER }));
  appendRunRecord(stateDir, OTHER, run('2026-08-07T11:09:00.000Z', { role: ROLES.REVIEWER }));
  archiveClosedTicket(stateDir, OTHER);

  const summary = readAuditSummary({ stateDir, repoRoot });

  assert.equal(summary.tickets.length, 2);
  const other = summary.tickets.find((t) => t.ticket === OTHER);
  assert.equal(other!.runs, 2);
});

// The waste question: which role is eating the time.
test('runs are grouped by role across every ticket', () => {
  const stateDir = makeTempDir('sum');
  const repoRoot = makeTempDir('repo');
  appendRunRecord(stateDir, ID, run('2026-08-07T10:01:00.000Z', { role: ROLES.CODER }));
  appendRunRecord(stateDir, OTHER, run('2026-08-07T11:01:00.000Z', { role: ROLES.CODER }));
  appendRunRecord(stateDir, OTHER, run('2026-08-07T11:09:00.000Z', { role: ROLES.REVIEWER }));

  const { byRole } = readAuditSummary({ stateDir, repoRoot });

  assert.equal(byRole.find((r) => r.role === 'coder')!.runs, 2);
  assert.equal(byRole.find((r) => r.role === 'reviewer')!.runs, 1);
});

test('a project with nothing recorded summarises to empty, not an error', () => {
  const summary = readAuditSummary({ stateDir: makeTempDir('sum'), repoRoot: makeTempDir('repo') });

  assert.deepEqual(summary.tickets, []);
  assert.deepEqual(summary.byRole, []);
});

// One junk file must not take down the whole scan — the id is derived from
// the filename, and readAudit throws on a shape assertValidTicketId rejects.
test('a malformed filename in the tickets directory is skipped, not thrown', () => {
  const stateDir = makeTempDir('sum');
  const repoRoot = makeTempDir('repo');
  appendRunRecord(stateDir, ID, run('2026-08-07T10:01:00.000Z'));
  fs.mkdirSync(path.join(stateDir, 'tickets'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'tickets', 'not-a-real-id.record.jsonl'), '');
  // Folders too, now that a ticket IS one. `closed` sits in here and cannot
  // be told from a ticket by shape — only the id rules separate them.
  fs.mkdirSync(path.join(stateDir, 'tickets', 'closed'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'tickets', 'not-a-real-id'), { recursive: true });

  const summary = readAuditSummary({ stateDir, repoRoot });

  assert.equal(summary.tickets.length, 1);
  assert.equal(summary.tickets[0]!.ticket, ID);
});

// THE RULE THE WHOLE FEATURE RESTS ON, at the aggregate level. Summing
// unmeasured runs as 0 reports an unmeasured ticket as a free one.
test('a ticket where nothing was measured totals null tokens, not zero', () => {
  const stateDir = makeTempDir('null-totals');
  const repoRoot = makeTempDir('repo');
  appendRunRecord(
    stateDir,
    ID,
    run('2026-08-07T10:01:00.000Z', { tokens: null, tokenSource: null }),
  );
  appendRunRecord(
    stateDir,
    ID,
    run('2026-08-07T10:05:00.000Z', { tokens: null, tokenSource: null }),
  );

  const { totals } = readAudit({ stateDir, repoRoot, ticketId: ID });

  assert.equal(totals.tokensIn, null);
  assert.equal(totals.tokensOut, null);
  assert.equal(totals.runsWithTokens, 0);
  assert.equal(totals.runs, 2);
});

// A partial total must not pass itself off as a complete one.
test('a partly measured ticket sums only what was measured, and says how many', () => {
  const stateDir = makeTempDir('part-totals');
  const repoRoot = makeTempDir('repo');
  appendRunRecord(stateDir, ID, run('2026-08-07T10:01:00.000Z'));
  appendRunRecord(
    stateDir,
    ID,
    run('2026-08-07T10:05:00.000Z', { tokens: null, tokenSource: null }),
  );

  const { totals } = readAudit({ stateDir, repoRoot, ticketId: ID });

  assert.equal(totals.tokensIn, 100);
  assert.equal(totals.runsWithTokens, 1);
  assert.equal(totals.runs, 2);
});

test('a role whose runs were never measured totals null, not zero', () => {
  const stateDir = makeTempDir('null-role');
  const repoRoot = makeTempDir('repo');
  appendRunRecord(
    stateDir,
    ID,
    run('2026-08-07T10:01:00.000Z', { tokens: null, tokenSource: null }),
  );

  const { byRole } = readAuditSummary({ stateDir, repoRoot });

  assert.equal(byRole[0]!.tokensIn, null);
  assert.equal(byRole[0]!.runsWithTokens, 0);
});

// Repo-level runs — a scan, a report, a compaction pass — are filed under no
// ticket. They were being written and then never read by anything.
test('repo-level runs appear in the summary, not just ticket ones', () => {
  const stateDir = makeTempDir('no-ticket');
  const repoRoot = makeTempDir('repo');
  appendRunRecord(stateDir, null, run('2026-08-07T09:00:00.000Z', { stage: 'odysse' }));
  appendRunRecord(stateDir, ID, run('2026-08-07T10:00:00.000Z'));

  const { tickets } = readAuditSummary({ stateDir, repoRoot });

  assert.equal(tickets.length, 2);
  assert.ok(
    tickets.some((t) => t.ticket === 'no-ticket'),
    'repo-level spend is invisible',
  );
});

// The same rule as unmeasured tokens, on the security number. "0 denied"
// with guardrails off reads as "nothing was blocked", not "nobody looked".
test('denied is null when guardrails was not watching', () => {
  const stateDir = makeTempDir('den');
  const repoRoot = makeTempDir('repo');
  appendRunRecord(stateDir, ID, run('2026-08-07T10:01:00.000Z'));

  assert.equal(readAudit({ stateDir, repoRoot, ticketId: ID }).totals.denied, null);
});

test('denied is a real count once guardrails is watching', () => {
  const stateDir = makeTempDir('den');
  const repoRoot = makeTempDir('repo');
  enableGuardrailsAudit(repoRoot);
  appendRunRecord(stateDir, ID, run('2026-08-07T10:01:00.000Z'));

  assert.equal(readAudit({ stateDir, repoRoot, ticketId: ID }).totals.denied, 0);
});

// --------------------------------------------------------------------------- Cache tokens.
// Claude counts cached input apart from input_tokens, so a total without it is far too low.

const CACHED = { in: 12, out: 310, cacheRead: 20480, cacheWrite: 4567 };

test('totals add up cache reads and cache writes', () => {
  const stateDir = makeTempDir('cache');
  const repoRoot = makeTempDir('repo');
  appendRunRecord(stateDir, ID, run('2026-08-07T10:01:00.000Z', { tokens: CACHED }));
  appendRunRecord(stateDir, ID, run('2026-08-07T10:05:00.000Z', { tokens: CACHED }));

  const { totals } = readAudit({ stateDir, repoRoot, ticketId: ID });

  assert.equal(totals.tokensCacheRead, 40960);
  assert.equal(totals.tokensCacheWrite, 9134);
});

// A row saved before the cache fields existed had cache too; nobody recorded it.
// It is left out of the cache totals and counted apart, never added as a measured 0.
test('an old row with tokens but no cache fields is left out of the cache totals', () => {
  const stateDir = makeTempDir('cache-old');
  const repoRoot = makeTempDir('repo');
  appendRunRecord(stateDir, ID, run('2026-08-07T10:01:00.000Z'));
  appendRunRecord(stateDir, ID, run('2026-08-07T10:05:00.000Z', { tokens: CACHED }));

  const { totals } = readAudit({ stateDir, repoRoot, ticketId: ID });

  assert.equal(totals.tokensCacheRead, 20480);
  assert.equal(totals.tokensCacheWrite, 4567);
  assert.equal(totals.runsWithTokens, 2);
  assert.equal(totals.runsWithCache, 1);
});

test('cache totals are null, not zero, when only old rows were measured', () => {
  const stateDir = makeTempDir('cache-all-old');
  const repoRoot = makeTempDir('repo');
  appendRunRecord(stateDir, ID, run('2026-08-07T10:01:00.000Z'));

  const { totals } = readAudit({ stateDir, repoRoot, ticketId: ID });

  assert.notEqual(totals.tokensIn, null);
  assert.equal(totals.tokensCacheRead, null);
  assert.equal(totals.tokensCacheWrite, null);
  assert.equal(totals.runsWithCache, 0);
});

test('cache totals are null, not zero, when no run had tokens measured', () => {
  const stateDir = makeTempDir('cache-null');
  const repoRoot = makeTempDir('repo');
  appendRunRecord(
    stateDir,
    ID,
    run('2026-08-07T10:01:00.000Z', { tokens: null, tokenSource: null }),
  );

  const { totals } = readAudit({ stateDir, repoRoot, ticketId: ID });

  assert.equal(totals.tokensCacheRead, null);
  assert.equal(totals.tokensCacheWrite, null);
});

test('the summary carries cache totals per ticket and per role', () => {
  const stateDir = makeTempDir('cache-sum');
  const repoRoot = makeTempDir('repo');
  appendRunRecord(stateDir, ID, run('2026-08-07T10:01:00.000Z', { tokens: CACHED }));
  appendRunRecord(stateDir, OTHER, run('2026-08-07T11:01:00.000Z', { tokens: CACHED }));
  appendRunRecord(
    stateDir,
    OTHER,
    run('2026-08-07T11:05:00.000Z', { role: ROLES.REVIEWER, tokens: null, tokenSource: null }),
  );

  const summary = readAuditSummary({ stateDir, repoRoot });

  assert.equal(summary.schema, 3);
  const row = summary.tickets.find((t) => t.ticket === ID)!;
  assert.equal(row.tokensCacheRead, 20480);
  assert.equal(row.tokensCacheWrite, 4567);
  const coder = summary.byRole.find((r) => r.role === 'coder')!;
  assert.equal(coder.tokensCacheRead, 40960);
  assert.equal(coder.tokensCacheWrite, 9134);
  const reviewer = summary.byRole.find((r) => r.role === 'reviewer')!;
  assert.equal(reviewer.tokensCacheRead, null);
  assert.equal(reviewer.tokensCacheWrite, null);
});
