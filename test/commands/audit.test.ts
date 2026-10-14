import { test } from 'node:test';
import { readAuditSummary } from '../../src/audit/read.js';
import { renderSummary } from '../../src/audit/render.js';
import assert from 'node:assert/strict';
import { makeTempDir } from '../helpers/tempDir.js';
import { appendRunRecord } from '../../src/audit/record.js';
import { AUDIT_STAGES } from '../../src/audit/record.js';
import { ROLES } from '../../src/types/ticket.js';
import { readAudit } from '../../src/audit/read.js';
import { renderAudit } from '../../src/audit/render.js';
import { runAuditCommand } from '../../installKit/bin/commands/audit.js';

const ID = '2026-08-07-add-dark-mode';

function seed() {
  const stateDir = makeTempDir('cmd');
  const repoRoot = makeTempDir('repo');
  appendRunRecord(stateDir, ID, {
    at: '2026-08-07T10:11:30.000Z',
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
  });
  return { stateDir, repoRoot };
}

// Captures what a command printed, so a test can assert on the words a
// user actually reads, the way test/commands/uxDefects2.test.ts does.
function capture(fn: () => void): { out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...args: unknown[]) => out.push(args.map(String).join(' '));
  console.error = (...args: unknown[]) => err.push(args.map(String).join(' '));
  try {
    fn();
  } finally {
    console.log = realLog;
    console.error = realError;
  }
  return { out: out.join('\n'), err: err.join('\n') };
}

test('the table names the role, the agent and the outcome', () => {
  const { stateDir, repoRoot } = seed();

  const text = renderAudit(readAudit({ stateDir, repoRoot, ticketId: ID }));

  assert.match(text, /coder/);
  assert.match(text, /claude/);
  assert.match(text, /ergon/);
});

// A chart reading "0 tool calls" would conclude the agent did nothing.
test('the table says the tool log is unavailable rather than showing none', () => {
  const { stateDir, repoRoot } = seed();

  const text = renderAudit(readAudit({ stateDir, repoRoot, ticketId: ID }));

  assert.match(text, /tool log (unavailable|not recorded)/i);
});

// One source of truth: the table is rendered from the object --json prints.
test('the table and the JSON report the same totals', () => {
  const { stateDir, repoRoot } = seed();
  const report = readAudit({ stateDir, repoRoot, ticketId: ID });

  assert.equal(report.totals.runs, 1);
  assert.match(renderAudit(report), /1 run/);
});

test('a ticket with nothing recorded renders a plain message, not a crash', () => {
  const report = readAudit({
    stateDir: makeTempDir('cmd'),
    repoRoot: makeTempDir('repo'),
    ticketId: ID,
  });

  assert.match(renderAudit(report), /nothing recorded/i);
});

// `glafka audit not-a-real-id` must not dump a raw stack trace — deep
// inside, assertValidTicketId throws on exactly this shape of input.
test('a malformed ticket id is refused with a clear message, not a raw assertion', () => {
  const { stateDir, repoRoot } = seed();

  assert.throws(
    () => runAuditCommand({ args: ['not-a-real-id'], stateDir, repoRoot }),
    /not a valid ticket id/,
  );
});

test('--json prints the report the table is rendered from, with matching totals', () => {
  const { stateDir, repoRoot } = seed();

  const { out: jsonOut } = capture(() =>
    runAuditCommand({ args: [ID, '--json'], stateDir, repoRoot }),
  );
  const parsed = JSON.parse(jsonOut) as { totals: { runs: number } };
  assert.equal(parsed.totals.runs, 1);

  const { out: tableOut } = capture(() => runAuditCommand({ args: [ID], stateDir, repoRoot }));
  assert.match(tableOut, /1 run/);
  assert.match(tableOut, /coder/);
});

// Task 10: no id means every ticket compared side by side, not one
// ticket's own no-ticket record.
test('with no ticket id, glafka audit compares every ticket', () => {
  const { stateDir, repoRoot } = seed();
  appendRunRecord(stateDir, '2026-08-07-fix-login-bypass', {
    at: '2026-08-07T11:00:00.000Z',
    kind: 'run',
    stage: AUDIT_STAGES.ERGON,
    role: ROLES.REVIEWER,
    agent: 'claude',
    durationMs: 2000,
    exitCode: 0,
    promptBytes: 10,
    responseBytes: 5,
    tokens: { in: 10, out: 2 },
    tokenSource: 'claude-json',
  });

  const { out } = capture(() => runAuditCommand({ args: [], stateDir, repoRoot }));

  assert.match(out, new RegExp(ID));
  assert.match(out, /2026-08-07-fix-login-bypass/);
  assert.match(out, /reviewer/);
});

test('with no ticket id and --json, glafka audit prints the summary the table is rendered from', () => {
  const { stateDir, repoRoot } = seed();

  const { out } = capture(() => runAuditCommand({ args: ['--json'], stateDir, repoRoot }));
  const parsed = JSON.parse(out) as { schema: number; tickets: { ticket: string }[] };

  assert.equal(parsed.schema, 3);
  assert.equal(parsed.tickets.length, 1);
  assert.equal(parsed.tickets[0]!.ticket, ID);
});

// THE POINT: null tokens must read as "not measured", never as a measured
// zero — the constraint the whole render depends on.
test('an unmeasured run renders as not-measured, never a bare zero', () => {
  const stateDir = makeTempDir('cmd');
  const repoRoot = makeTempDir('repo');
  appendRunRecord(stateDir, ID, {
    at: '2026-08-07T10:11:30.000Z',
    kind: 'run',
    stage: AUDIT_STAGES.ERGON,
    role: ROLES.CODER,
    agent: 'claude',
    durationMs: 638000,
    exitCode: 0,
    promptBytes: 48213,
    responseBytes: 6210,
    tokens: null,
    tokenSource: null,
  });

  const text = renderAudit(readAudit({ stateDir, repoRoot, ticketId: ID }));

  assert.match(text, /tokens not measured/);
  assert.doesNotMatch(text, /0→0/);
});

// A signal-killed run has no exit code. "exit null" would read as a real,
// nameable outcome instead of "we do not know how it ended".
test('a run with no exit code recorded does not render the literal word "null"', () => {
  const stateDir = makeTempDir('cmd');
  const repoRoot = makeTempDir('repo');
  appendRunRecord(stateDir, ID, {
    at: '2026-08-07T10:11:30.000Z',
    kind: 'run',
    stage: AUDIT_STAGES.ERGON,
    role: ROLES.CODER,
    agent: 'claude',
    durationMs: 638000,
    exitCode: null,
    promptBytes: 48213,
    responseBytes: 6210,
    tokens: { in: 100, out: 20 },
    tokenSource: 'claude-json',
  });

  const text = renderAudit(readAudit({ stateDir, repoRoot, ticketId: ID }));

  assert.doesNotMatch(text, /exit null/);
});

// A fixed-width ticket column let one long name shear every column to its
// right out of alignment, which is most of what a comparison table is for.
test('a long ticket name does not break the column alignment', () => {
  const stateDir = makeTempDir('cmd');
  const repoRoot = makeTempDir('repo');
  const long = '2026-08-07-a-very-long-ticket-name-that-overflows';
  for (const id of [long, '2026-08-07-short']) {
    appendRunRecord(stateDir, id, {
      at: '2026-08-07T10:00:00.000Z',
      kind: 'run',
      stage: AUDIT_STAGES.ERGON,
      role: ROLES.CODER,
      agent: 'claude',
      durationMs: 1000,
      exitCode: 0,
      promptBytes: 1,
      responseBytes: 1,
      tokens: { in: 1, out: 1 },
      tokenSource: 'claude-json',
    });
  }

  const lines = renderSummary(readAuditSummary({ stateDir, repoRoot })).split('\n');
  const header = lines[0]!;
  const rows = lines.filter((l) => l.includes('2026-08-07-'));

  // Every column is padded, so header and rows are the same width when
  // they line up. A fixed pad made the long row longer than the rest.
  assert.equal(rows.length, 2);
  for (const row of rows) assert.equal(row.length, header.length, row);
});

// A denied tool call that does not say WHAT was denied answers none of the
// questions the tool log exists for.
test('a tool line names the command, not just the op', () => {
  const report = {
    schema: 3 as const,
    ticket: '2026-08-07-add-dark-mode',
    sources: { runs: false, stages: false, tools: true },
    toolsPartial: false,
    events: [
      {
        at: '2026-08-07T10:11:36.000Z',
        kind: 'tool' as const,
        op: 'exec',
        allow: false,
        action: { command: 'curl evil.com' },
      },
    ],
    totals: {
      runs: 0,
      durationMs: null,
      runsWithDuration: 0,
      tokensIn: null,
      tokensOut: null,
      tokensCacheRead: null,
      tokensCacheWrite: null,
      runsWithTokens: 0,
      denied: 1,
    },
  };

  const out = renderAudit(report);

  assert.match(out, /curl evil\.com/);
  assert.match(out, /DENY/);
});

// Cached input is most of a Claude run's input. A table that hides it says a run was cheap when it was not.
function seedCached() {
  const stateDir = makeTempDir('cmd');
  const repoRoot = makeTempDir('repo');
  appendRunRecord(stateDir, ID, {
    at: '2026-08-07T10:11:30.000Z',
    kind: 'run',
    stage: AUDIT_STAGES.ERGON,
    role: ROLES.CODER,
    agent: 'claude',
    durationMs: 2300,
    exitCode: 0,
    promptBytes: 100,
    responseBytes: 50,
    tokens: { in: 12, out: 310, cacheRead: 20480, cacheWrite: 4567 },
    tokenSource: 'claude-json',
  });
  return { stateDir, repoRoot };
}

test('the ticket table shows cache reads and writes, on the run line and in the head', () => {
  const { stateDir, repoRoot } = seedCached();

  const lines = renderAudit(readAudit({ stateDir, repoRoot, ticketId: ID })).split('\n');

  assert.match(lines[0]!, /20\.5k cache read · 4\.6k cache write/);
  const runLine = lines.find((l) => l.includes(' run '))!;
  assert.match(runLine, /12→310/);
  assert.match(runLine, /20\.5k cache read · 4\.6k cache write/);
});

// An old row was saved before cache was counted. It must not claim a measured 0.
test('an old run row with no cache fields says nothing about cache on its line', () => {
  const { stateDir, repoRoot } = seed();

  const lines = renderAudit(readAudit({ stateDir, repoRoot, ticketId: ID })).split('\n');

  const runLine = lines.find((l) => l.includes(' run '))!;
  assert.doesNotMatch(runLine, /cache/);
});

test('the summary table has cache read and cache write columns', () => {
  const { stateDir, repoRoot } = seedCached();

  const lines = renderSummary(readAuditSummary({ stateDir, repoRoot })).split('\n');

  assert.match(lines[0]!, /cache read\s+cache write/);
  const row = lines.find((l) => l.startsWith(ID))!;
  assert.match(row, /20\.5k\s+4\.6k/);
  assert.equal(row.length, lines[0]!.length);
  const roleHead = lines.find((l) => l.startsWith('by role'))!;
  assert.match(roleHead, /cache read\s+cache write/);
  const role = lines.find((l) => l.startsWith('coder'))!;
  assert.match(role, /20\.5k\s+4\.6k/);
});
