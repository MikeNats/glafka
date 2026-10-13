import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { makeGitRepo } from '../helpers/gitFixture.js';
import { genesis } from '../../src/commands/genesis/genesis.js';
import { makeTempDir } from '../helpers/tempDir.js';
import {
  ergonReview,
  dispatchReviewer,
  ergonReviewStatus,
  ergonStatus,
  parseVerdictFromLog,
  VERDICT_SOURCE,
} from '../../src/commands/ergon/ergon.js';
import { backgroundStatus } from '../../src/ticket/background.js';
import { readTicket as readTicketDirect, REVIEW_VERDICT } from '../../src/ticket/ticketStore.js';
import { resolveVerdict } from '../../src/commands/ergon/utils.js';

// Runs the built file, not the TS source.
// Run `npm run build` first.
const BIN = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'dist',
  'installKit',
  'bin',
  'glafka.js',
);

// The reviewer expects stateDir at `<repoRoot>/.glafka`.
// The test must use that same path, not a random folder.
function stateDirFor(repoRoot: string) {
  return path.join(repoRoot, '.glafka');
}

// 60s, not 20s. These tests wait on a real spawned CLI process. During a full `npm test` the machine
// is saturated (8 files in parallel, each spawning git and node), so a cold process can take far longer than 20s to be scheduled. The assertions here are about ordering, not speed, so a longer wait costs nothing when things are healthy and stops false failures when they are not.
function waitFor(
  predicate: () => boolean,
  { timeoutMs = 60000, intervalMs = 20 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('timed out waiting'));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

// This starts a real process for the reviewer.
// It reports back with the real CLI. Nothing is faked.
test(
  'dispatchReviewer spawns a real process that reports its verdict back through the real CLI',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = stateDirFor(repoRoot);
    const ticket = await genesis({ repoRoot, stateDir, content: 'reviewable work' });
    fs.writeFileSync(path.join(ticket.worktree!, 'feature.txt'), 'new feature\n');
    execFileSync('git', ['add', 'feature.txt'], { cwd: ticket.worktree! });
    execFileSync('git', ['commit', '-q', '-m', 'add feature'], { cwd: ticket.worktree! });

    const { ticket: prepared, prompt } = await ergonReview({
      stateDir,
      id: ticket.id,
      repoRoot,
      baseRef: 'main',
    });

    const { pid } = dispatchReviewer({
      stateDir,
      ticket: prepared,
      prompt,
      agentCmd: `node "${BIN}" krisis ${ticket.id} --verdict blocking --finding "feature.txt:1 — needs a test"`,
    });
    assert.ok(pid! > 0);

    await waitFor(
      () => backgroundStatus({ stateDir, id: ticket.id, role: 'reviewer' }).state === 'finished',
    );

    const { status, findings, verdict } = ergonReviewStatus({ stateDir, id: ticket.id });
    assert.equal(status.state, 'finished');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].verdict, 'blocking');
    assert.match(findings[0].finding!, /needs a test/);
    assert.equal(verdict.source, VERDICT_SOURCE.KRISIS);
    assert.equal(verdict.verdict, 'blocking');
  },
);

test(
  'dispatchReviewer refuses to start a second reviewer over a still-running one',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = stateDirFor(repoRoot);
    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });
    fs.writeFileSync(path.join(ticket.worktree!, 'a.txt'), 'a\n');
    execFileSync('git', ['add', 'a.txt'], { cwd: ticket.worktree! });
    execFileSync('git', ['commit', '-q', '-m', 'add a'], { cwd: ticket.worktree! });

    const { ticket: prepared, prompt } = await ergonReview({
      stateDir,
      id: ticket.id,
      repoRoot,
      baseRef: 'main',
    });
    dispatchReviewer({ stateDir, ticket: prepared, prompt, agentCmd: 'sleep 30' });

    assert.throws(
      () => dispatchReviewer({ stateDir, ticket: prepared, prompt, agentCmd: 'true' }),
      /still running/,
    );

    const status = backgroundStatus({ stateDir, id: ticket.id, role: 'reviewer' });
    const pid = 'pid' in status ? status.pid : undefined;
    if (pid) process.kill(pid, 'SIGKILL');
  },
);

// A running reviewer must not block a coder run.
// The coder writes, the reviewer only reads.
test(
  'a live reviewer does not block a coder run on the same ticket',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = stateDirFor(repoRoot);
    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });
    fs.writeFileSync(path.join(ticket.worktree!, 'a.txt'), 'a\n');
    execFileSync('git', ['add', 'a.txt'], { cwd: ticket.worktree! });
    execFileSync('git', ['commit', '-q', '-m', 'add a'], { cwd: ticket.worktree! });

    const { ticket: prepared, prompt } = await ergonReview({
      stateDir,
      id: ticket.id,
      repoRoot,
      baseRef: 'main',
    });
    const reviewer = dispatchReviewer({ stateDir, ticket: prepared, prompt, agentCmd: 'sleep 30' });

    // The coder's status check must not see the reviewer.
    const result = await ergonStatus({ stateDir, id: ticket.id });
    assert.equal(result.status.state, 'not-started');

    process.kill(reviewer.pid!, 'SIGKILL');
  },
);

// --------------------------------------------------------------------------- parseVerdictFromLog is
// tested alone here, with no ticket. ---------------------------------------------------------------------------

function tempLogFile(content: string) {
  const filePath = path.join(makeTempDir('log'), 'log');
  fs.writeFileSync(filePath, content);
  return filePath;
}

test('parseVerdictFromLog reads a clean verdict with no reason needed', () => {
  const logPath = tempLogFile('some reasoning here\nVERDICT: clean\n');
  assert.deepEqual(parseVerdictFromLog(logPath), { verdict: 'clean', finding: null });
});

test('parseVerdictFromLog reads a blocking verdict along with its reason', () => {
  const logPath = tempLogFile('VERDICT: blocking — signup.js:44 no rate limit\n');
  assert.deepEqual(parseVerdictFromLog(logPath), {
    verdict: 'blocking',
    finding: 'signup.js:44 no rate limit',
  });
});

test('parseVerdictFromLog is case-insensitive on the keyword and the verdict word', () => {
  const logPath = tempLogFile('verdict: BLOCKING - the thing is broken\n');
  assert.deepEqual(parseVerdictFromLog(logPath), {
    verdict: 'blocking',
    finding: 'the thing is broken',
  });
});

test('parseVerdictFromLog returns null when no VERDICT line exists', () => {
  const logPath = tempLogFile('looks fine to me, nothing else to say\n');
  assert.equal(parseVerdictFromLog(logPath), null);
});

test('parseVerdictFromLog returns null for a log file that does not exist', () => {
  assert.equal(parseVerdictFromLog('/does/not/exist'), null);
  assert.equal(parseVerdictFromLog(null), null);
});

// The example text also has a "VERDICT: clean" line.
// Only the last VERDICT line should count.
test('parseVerdictFromLog takes the LAST verdict line, not the first', () => {
  const logPath = tempLogFile(
    'reminding myself to finish with one of:\n' +
      'VERDICT: clean\n' +
      'VERDICT: blocking - <reason>\n\n' +
      'looked at the diff, found a real problem.\n' +
      'VERDICT: blocking — db.js:42 SQL injection\n',
  );
  assert.deepEqual(parseVerdictFromLog(logPath), {
    verdict: 'blocking',
    finding: 'db.js:42 SQL injection',
  });
});

test('parseVerdictFromLog ignores trailing blank lines after the verdict line', () => {
  const logPath = tempLogFile('VERDICT: clean\n\n\n');
  assert.deepEqual(parseVerdictFromLog(logPath), { verdict: 'clean', finding: null });
});

// A VERDICT line only counts if it is the last line with text.
// Old bug: text inside a shown diff looked like a real verdict.
test("parseVerdictFromLog does not trust a VERDICT line that isn't the log's last line", () => {
  const logPath = tempLogFile(
    'VERDICT: clean\n' +
      '\n' +
      '-- diff shown for context --\n' +
      '+const VERDICT_LINE_RE = /^VERDICT:.../;  // from ergon.js itself\n',
  );
  assert.equal(parseVerdictFromLog(logPath), null);
});

// --------------------------------------------------------------------------- Tests the full verdict
// flow. No answer is never read as "clean". ---------------------------------------------------------------------------

test(
  'a reviewer that never calls krisis, but prints VERDICT in its own output, still resolves via the log line',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = stateDirFor(repoRoot);
    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });
    fs.writeFileSync(path.join(ticket.worktree!, 'a.txt'), 'a\n');
    execFileSync('git', ['add', 'a.txt'], { cwd: ticket.worktree! });
    execFileSync('git', ['commit', '-q', '-m', 'add a'], { cwd: ticket.worktree! });

    const { ticket: prepared, prompt } = await ergonReview({
      stateDir,
      id: ticket.id,
      repoRoot,
      baseRef: 'main',
    });
    // Acts like a reviewer that can only print text, not run krisis.
    dispatchReviewer({
      stateDir,
      ticket: prepared,
      prompt,
      agentCmd: 'echo "looked at the diff\nVERDICT: blocking - missing test coverage"',
    });

    await waitFor(
      () => backgroundStatus({ stateDir, id: ticket.id, role: 'reviewer' }).state === 'finished',
    );

    const { findings, verdict } = ergonReviewStatus({ stateDir, id: ticket.id });
    assert.deepEqual(findings, []);
    assert.equal(verdict.source, VERDICT_SOURCE.LOG_LINE);
    assert.equal(verdict.verdict, 'blocking');
    assert.match(verdict.finding!, /missing test coverage/);
  },
);

test(
  'a reviewer that reports nothing readable resolves to NONE, never to clean',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = stateDirFor(repoRoot);
    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });
    fs.writeFileSync(path.join(ticket.worktree!, 'a.txt'), 'a\n');
    execFileSync('git', ['add', 'a.txt'], { cwd: ticket.worktree! });
    execFileSync('git', ['commit', '-q', '-m', 'add a'], { cwd: ticket.worktree! });

    const { ticket: prepared, prompt } = await ergonReview({
      stateDir,
      id: ticket.id,
      repoRoot,
      baseRef: 'main',
    });
    dispatchReviewer({ stateDir, ticket: prepared, prompt, agentCmd: 'true' });

    await waitFor(
      () => backgroundStatus({ stateDir, id: ticket.id, role: 'reviewer' }).state === 'finished',
    );

    const { verdict } = ergonReviewStatus({ stateDir, id: ticket.id });
    assert.equal(verdict.source, VERDICT_SOURCE.NONE);
    assert.equal(verdict.verdict, null);
  },
);

test(
  'a reviewer PROCESS that fails resolves to run-failed, not to a review verdict at all',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = stateDirFor(repoRoot);
    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });
    fs.writeFileSync(path.join(ticket.worktree!, 'a.txt'), 'a\n');
    execFileSync('git', ['add', 'a.txt'], { cwd: ticket.worktree! });
    execFileSync('git', ['commit', '-q', '-m', 'add a'], { cwd: ticket.worktree! });

    const { ticket: prepared, prompt } = await ergonReview({
      stateDir,
      id: ticket.id,
      repoRoot,
      baseRef: 'main',
    });
    dispatchReviewer({ stateDir, ticket: prepared, prompt, agentCmd: 'exit 1' });

    await waitFor(
      () => backgroundStatus({ stateDir, id: ticket.id, role: 'reviewer' }).state === 'failed',
    );

    const { verdict } = ergonReviewStatus({ stateDir, id: ticket.id });
    assert.equal(verdict.source, VERDICT_SOURCE.RUN_FAILED);
    assert.equal(verdict.verdict, null);
  },
);

// Old bug: a real krisis call was thrown away if the process failed later.
// The krisis call should still count.
test(
  'a krisis call survives the reviewer PROCESS failing afterward — not discarded as run-failed',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = stateDirFor(repoRoot);
    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });
    fs.writeFileSync(path.join(ticket.worktree!, 'a.txt'), 'a\n');
    execFileSync('git', ['add', 'a.txt'], { cwd: ticket.worktree! });
    execFileSync('git', ['commit', '-q', '-m', 'add a'], { cwd: ticket.worktree! });

    const {
      ticket: prepared,
      prompt,
      reviewToken,
    } = await ergonReview({
      stateDir,
      id: ticket.id,
      repoRoot,
      baseRef: 'main',
    });
    // Sends the token, like a real review would.
    // Only a verified "clean" can close the round.
    dispatchReviewer({
      stateDir,
      ticket: prepared,
      prompt,
      agentCmd: `node "${BIN}" krisis ${ticket.id} --verdict clean --token ${reviewToken}; exit 1`,
    });

    await waitFor(
      () => backgroundStatus({ stateDir, id: ticket.id, role: 'reviewer' }).state === 'failed',
    );

    const { findings, verdict } = ergonReviewStatus({ stateDir, id: ticket.id });
    assert.equal(findings.length, 1);
    assert.equal(verdict.source, VERDICT_SOURCE.KRISIS);
    assert.equal(verdict.verdict, 'clean');
  },
);

test(
  'a reviewer still running resolves to not-done, not to any verdict',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = stateDirFor(repoRoot);
    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });
    fs.writeFileSync(path.join(ticket.worktree!, 'a.txt'), 'a\n');
    execFileSync('git', ['add', 'a.txt'], { cwd: ticket.worktree! });
    execFileSync('git', ['commit', '-q', '-m', 'add a'], { cwd: ticket.worktree! });

    const { ticket: prepared, prompt } = await ergonReview({
      stateDir,
      id: ticket.id,
      repoRoot,
      baseRef: 'main',
    });
    const reviewer = dispatchReviewer({ stateDir, ticket: prepared, prompt, agentCmd: 'sleep 30' });

    const { verdict, status } = ergonReviewStatus({ stateDir, id: ticket.id });
    assert.equal(status.state, 'running');
    assert.equal(verdict.source, VERDICT_SOURCE.NOT_DONE);
    assert.equal(verdict.verdict, null);

    process.kill(reviewer.pid!, 'SIGKILL');
  },
);

// A krisis call only counts once the process is done.
// A "clean" verdict that comes too early must not be trusted.
test(
  'a clean krisis call from a reviewer still mid-run is NOT trusted early',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = stateDirFor(repoRoot);
    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });
    fs.writeFileSync(path.join(ticket.worktree!, 'a.txt'), 'a\n');
    execFileSync('git', ['add', 'a.txt'], { cwd: ticket.worktree! });
    execFileSync('git', ['commit', '-q', '-m', 'add a'], { cwd: ticket.worktree! });

    const { ticket: prepared, prompt } = await ergonReview({
      stateDir,
      id: ticket.id,
      repoRoot,
      baseRef: 'main',
    });
    const reviewer = dispatchReviewer({
      stateDir,
      ticket: prepared,
      prompt,
      agentCmd: `node "${BIN}" krisis ${ticket.id} --verdict clean && sleep 30`,
    });

    await waitFor(() => {
      const t = readTicketDirect(stateDir, ticket.id);
      return (t.reviewFindings ?? []).length > 0;
    });

    const { verdict, status } = ergonReviewStatus({ stateDir, id: ticket.id });
    assert.equal(status.state, 'running');
    assert.equal(verdict.source, VERDICT_SOURCE.NOT_DONE);
    assert.equal(verdict.verdict, null);

    process.kill(reviewer.pid!, 'SIGKILL');
  },
);

// Only a verified CLEAN can close a round as clean.
// This stops the coder from marking its own work clean.
test('an unverified CLEAN does not resolve the round as clean', () => {
  const resolved = resolveVerdict({
    status: { state: 'finished', exitCode: 0, logPath: '/tmp/x' },
    findings: [{ verdict: REVIEW_VERDICT.CLEAN, finding: null, verified: false, at: 'now' }],
  });
  assert.notEqual(resolved.verdict, REVIEW_VERDICT.CLEAN);
});

test('a verified CLEAN still resolves the round', () => {
  const resolved = resolveVerdict({
    status: { state: 'finished', exitCode: 0, logPath: '/tmp/x' },
    findings: [{ verdict: REVIEW_VERDICT.CLEAN, finding: null, verified: true, at: 'now' }],
  });
  assert.equal(resolved.verdict, REVIEW_VERDICT.CLEAN);
});

// Blocking a push is safe, so we trust it even if not verified.
test('an unverified BLOCKING still blocks', () => {
  const resolved = resolveVerdict({
    status: { state: 'finished', exitCode: 0, logPath: '/tmp/x' },
    findings: [{ verdict: REVIEW_VERDICT.BLOCKING, finding: 'bad', verified: false, at: 'now' }],
  });
  assert.equal(resolved.verdict, REVIEW_VERDICT.BLOCKING);
});

// The old code read the whole log file into memory to find the last line.
// This checks reading a big log stays fast and uses little memory.
test('the verdict is read from the tail, not by loading the whole log', () => {
  const dir = makeTempDir('biglog');
  const logPath = path.join(dir, 'log');
  // Writes in small pieces so the test itself uses little memory.
  const chunk = `${'x'.repeat(1023)}\n`.repeat(1000); // about 1MB
  for (let i = 0; i < 60; i++) fs.appendFileSync(logPath, chunk);
  fs.appendFileSync(logPath, 'VERDICT: blocking — a.ts:1 no test\n');

  const before = process.memoryUsage().heapUsed;
  const parsed = parseVerdictFromLog(logPath);
  const grewMb = (process.memoryUsage().heapUsed - before) / 1024 / 1024;

  assert.deepEqual(parsed, { verdict: 'blocking', finding: 'a.ts:1 no test' });
  assert.ok(grewMb < 40, `reading a 60MB log grew the heap by ${Math.round(grewMb)}MB`);
});

test('a verdict line longer than the tail window is still read', () => {
  const finding = 'a.ts:1 — '.repeat(2000);
  const logPath = tempLogFile(`noise\nVERDICT: blocking — ${finding}\n`);
  assert.equal(parseVerdictFromLog(logPath)?.verdict, 'blocking');
});

test('a log with trailing blank lines still resolves to the verdict line', () => {
  const logPath = tempLogFile('reasoning\nVERDICT: clean\n\n\n   \n');
  assert.deepEqual(parseVerdictFromLog(logPath), { verdict: 'clean', finding: null });
});

// --------------------------------------------------------------------------- JSON-wrapped output

// An agent run with `--output-format json` is the only way to get token counts
// out of it, but that wraps the whole reply in one object and the VERDICT line
// stops being a line at all. Without this the safety net silently disappears
// the moment someone turns token capture on.
test('parseVerdictFromLog reads a verdict wrapped in --output-format json', () => {
  const log = tempLogFile(
    JSON.stringify({
      type: 'result',
      usage: { input_tokens: 900, output_tokens: 20 },
      result: 'I read the diff and found nothing wrong.\nVERDICT: clean',
    }),
  );

  assert.deepEqual(parseVerdictFromLog(log), { verdict: REVIEW_VERDICT.CLEAN, finding: null });
});

test('a blocking verdict and its reason survive the JSON wrapper', () => {
  const log = tempLogFile(
    JSON.stringify({
      type: 'result',
      result: 'src/a.ts:3 leaks a token\nVERDICT: blocking — a token is logged',
    }),
  );

  assert.deepEqual(parseVerdictFromLog(log), {
    verdict: REVIEW_VERDICT.BLOCKING,
    finding: 'a token is logged',
  });
});

// THE SAFETY RULE, which must hold inside the wrapper exactly as it does
// outside it: a verdict sitting ABOVE substantive output is a draft the
// reviewer then revised, never the round's answer.
test('a verdict buried above substantive output is not read, JSON or not', () => {
  const buried = 'VERDICT: clean\nthen I looked again\nand found three real problems\nand a fourth';
  const plain = tempLogFile(buried);
  const wrapped = tempLogFile(JSON.stringify({ type: 'result', result: buried }));

  assert.equal(parseVerdictFromLog(plain), null);
  assert.equal(parseVerdictFromLog(wrapped), null);
});

// Not every JSON line is an agent reply. A log that happens to contain one
// must not be mistaken for a wrapper.
test('JSON without a result string is left alone', () => {
  const log = tempLogFile('{"type":"assistant","usage":{"input_tokens":10}}');

  assert.equal(parseVerdictFromLog(log), null);
});
