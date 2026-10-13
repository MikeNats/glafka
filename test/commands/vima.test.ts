import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { makeGitRepo } from '../helpers/gitFixture.js';
import { genesis, createTicket } from '../../src/commands/genesis/genesis.js';
import { cancel } from '../../src/commands/cancel/cancel.js';
import { lysis } from '../../src/commands/lysis/lysis.js';
import { vima, vimaAll } from '../../src/commands/vima/vima.js';
import { runNotify } from '../../src/commands/vima/utils.js';
import { runVima } from '../../installKit/bin/commands/vima.js';
import {
  backgroundStatus,
  killBackground,
  markExternalRunStarted,
} from '../../src/ticket/background.js';
import { runFiles, ticketFiles, ticketsDir } from '../../src/ticket/paths.js';
import { makeTempDir } from '../helpers/tempDir.js';
import { codeState } from '../../src/commands/epalitheusis/epalitheusis.js';
import {
  readTicket,
  recordAporia,
  recordStage,
  openVerifyRound,
  appendReviewFinding,
  STAGES,
  RUN_OUTCOMES,
  REVIEW_VERDICT,
  wasNotified,
} from '../../src/ticket/ticketStore.js';
import { withoutAgentCmd } from '../helpers/noAgentEnv.js';

// These tests need no agent configured. Cleared here, so running this file directly is safe too.
withoutAgentCmd();

// This runs the built app file, not the source code.
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

function stateDirFor(repoRoot: string) {
  return path.join(repoRoot, '.glafka');
}

// 60s, not 20s. These wait on a real spawned process, and a full `npm test` saturates the machine, so
// a cold process can take well past 20s to be scheduled. The assertions are about ordering, not speed.
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

// A fake reviewer for tests. It reads the token from the prompt
// and sends it back, like a real reviewer would.
const cleanReviewer = (id: string) =>
  `token=$(grep -o -- "--token [0-9a-f]*" | head -1 | cut -d" " -f2); ` +
  `node "${BIN}" krisis ${id} --verdict clean --token "$token"`;

// A fake coder. It commits one file so review has something to check.
const COMMITTING_CODER =
  'sh -c \'echo x > done.txt && git add done.txt && git commit -q -m "did the step"\'';

// Writes pid and exit-code files by hand.
// This fakes "the coder already finished" without a real run.
function fakeFinishedRun(stateDir: string, id: string, role: string) {
  const { dir, pidPath, exitCodePath, logPath } = runFiles(stateDir, id, role);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(pidPath, '999999');
  fs.writeFileSync(exitCodePath, '0');
  fs.writeFileSync(logPath, '');
}
const fakeFinishedCoder = (stateDir: string, id: string) => fakeFinishedRun(stateDir, id, 'coder');

// A plain test config. Does not read any real .glafka.json file.
function baseConfig(overrides = {}) {
  return {
    baseRef: 'main',
    checksCmd: null,
    e2eCmd: null,
    checksTimeoutMs: 10_000,
    e2eTimeoutMs: 10_000,
    ergonTimeoutMs: 60_000,
    agents: {},
    maxReviewRounds: 3,
    notifyCmd: null,
    reviewDoc: null,
    observability: { enabled: false },
    ...overrides,
  };
}

// --------------------------------------------------------------------------- Tests for end states.
// No real process needed. ---------------------------------------------------------------------------

test('vima does nothing for a cancelled ticket', { concurrency: true }, async () => {
  const repoRoot = makeGitRepo();
  const stateDir = stateDirFor(repoRoot);
  const ticket = createTicket({ stateDir, repoRoot, content: 'task' });
  await cancel({ repoRoot, stateDir, id: ticket.id });

  const result = await vima({ stateDir, id: ticket.id, repoRoot, config: baseConfig() });
  assert.deepEqual(result, { id: ticket.id, action: 'none', reason: 'cancelled' });
});

test('vima does nothing for a closed ticket', { concurrency: true }, async () => {
  const repoRoot = makeGitRepo();
  const stateDir = stateDirFor(repoRoot);
  const ticket = await genesis({ repoRoot, stateDir, content: 'task' });
  await lysis({ repoRoot, stateDir, id: ticket.id, keep: 'all' });

  const result = await vima({ stateDir, id: ticket.id, repoRoot, config: baseConfig() });
  assert.deepEqual(result, { id: ticket.id, action: 'none', reason: 'closed' });
});

// A coder that stopped on purpose should not go to review by mistake.
test('vima refuses to touch a ticket with a recorded aporia', { concurrency: true }, async () => {
  const repoRoot = makeGitRepo();
  const stateDir = stateDirFor(repoRoot);
  const ticket = await genesis({ repoRoot, stateDir, content: 'task', planContent: '1. do it' });
  recordAporia(stateDir, ticket.id, 'step 2 assumes a table that does not exist');

  const result = await vima({ stateDir, id: ticket.id, repoRoot, config: baseConfig() });
  assert.equal(result.action, 'none');
  assert.match(result.reason!, /needs you — step 2 assumes a table/);
});

test(
  'vima waits for a phased ticket with no plan yet, rather than guessing',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = stateDirFor(repoRoot);
    const ticket = createTicket({ stateDir, repoRoot, content: 'an idea' });

    const result = await vima({ stateDir, id: ticket.id, repoRoot, config: baseConfig() });
    assert.deepEqual(result, { id: ticket.id, action: 'none', reason: 'no plan yet' });
  },
);

test(
  'vima reports it has no coder agent to spawn, rather than silently doing nothing',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = stateDirFor(repoRoot);
    const ticket = await genesis({ repoRoot, stateDir, content: 'task', planContent: '1. do it' });

    const result = await vima({ stateDir, id: ticket.id, repoRoot, config: baseConfig() });
    assert.equal(result.action, 'none');
    assert.match(result.reason!, /no coder agent configured/);
  },
);

// --------------------------------------------------------------------------- Tests using a real
// background process, like a real ticket run. ---------------------------------------------------------------------------

test(
  'vima spawns the coder once a plan is approved and a coder agent is configured',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = stateDirFor(repoRoot);
    const ticket = await genesis({ repoRoot, stateDir, content: 'task', planContent: '1. do it' });

    const result = await vima({
      stateDir,
      id: ticket.id,
      repoRoot,
      config: baseConfig({ agents: { coder: 'sleep 30' } }),
    });

    assert.equal(result.action, 'spawned-coder');
    assert.ok(result.pid! > 0);
    assert.equal(backgroundStatus({ stateDir, id: ticket.id, role: 'coder' }).state, 'running');

    process.kill(result.pid!, 'SIGKILL');
  },
);

test(
  'vima calling twice in a row does not double-spawn — the second tick sees it running',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = stateDirFor(repoRoot);
    const ticket = await genesis({ repoRoot, stateDir, content: 'task', planContent: '1. do it' });
    const config = baseConfig({ agents: { coder: 'sleep 30' } });

    const first = await vima({ stateDir, id: ticket.id, repoRoot, config });
    const second = await vima({ stateDir, id: ticket.id, repoRoot, config });

    assert.equal(first.action, 'spawned-coder');
    assert.equal(second.action, 'none');
    assert.match(second.reason!, /coder running/);

    process.kill(first.pid!, 'SIGKILL');
  },
);

// The documented Claude Code flow (`glafka ergon <id>`, then the harness's own
// Agent tool spawns the real coder) never calls spawnBackground, so glafka used to see "not-started" forever and vima would spawn a SECOND coder into the same worktree the very next tick.
test(
  'vima does not spawn a second coder over one dispatched through the documented (non-background) path',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = stateDirFor(repoRoot);
    const ticket = await genesis({ repoRoot, stateDir, content: 'task', planContent: '1. do it' });

    // Stands in for `glafka ergon <id>` handing the prompt to a subagent
    // this process never spawns — see markExternalRunStarted's own callers.
    markExternalRunStarted({ stateDir, id: ticket.id, role: 'coder' });

    const result = await vima({
      stateDir,
      id: ticket.id,
      repoRoot,
      config: baseConfig({ agents: { coder: 'sleep 30' } }),
    });

    assert.equal(result.action, 'none');
    assert.match(result.reason!, /coder running/);
  },
);

test(
  "vima moves a finished, uncommitted coder run to 'needs you' instead of respawning blindly",
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    // Add the .gitignore line first, so genesis() makes no commits.
    // This keeps the diff empty for the test.
    fs.writeFileSync(path.join(repoRoot, '.gitignore'), '.env.glafka\n');
    execFileSync('git', ['add', '.gitignore'], { cwd: repoRoot });
    execFileSync('git', ['commit', '-q', '-m', 'seed gitignore'], { cwd: repoRoot });

    const stateDir = stateDirFor(repoRoot);
    const ticket = await genesis({ repoRoot, stateDir, content: 'task', planContent: '1. do it' });
    const config = baseConfig({ agents: { coder: 'true' } });

    await vima({ stateDir, id: ticket.id, repoRoot, config });
    await waitFor(
      () => backgroundStatus({ stateDir, id: ticket.id, role: 'coder' }).state === 'finished',
    );

    const result = await vima({ stateDir, id: ticket.id, repoRoot, config });
    assert.equal(result.action, 'none');
    assert.match(result.reason!, /committed nothing/);
  },
);

test(
  'vima routes a finished, committed run to review, spawning a real reviewer',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = stateDirFor(repoRoot);
    const ticket = await genesis({ repoRoot, stateDir, content: 'task', planContent: '1. do it' });
    const config = baseConfig({
      agents: {
        coder: COMMITTING_CODER,
        reviewer: cleanReviewer(ticket.id),
      },
    });

    await vima({ stateDir, id: ticket.id, repoRoot, config });
    await waitFor(
      () => backgroundStatus({ stateDir, id: ticket.id, role: 'coder' }).state === 'finished',
    );

    const routed = await vima({ stateDir, id: ticket.id, repoRoot, config });
    assert.equal(routed.action, 'spawned-reviewer');

    await waitFor(
      () => backgroundStatus({ stateDir, id: ticket.id, role: 'reviewer' }).state === 'finished',
    );

    const ready = await vima({ stateDir, id: ticket.id, repoRoot, config });
    assert.equal(ready.action, 'ready');
    assert.match(ready.reason!, /clean/);
  },
);

test(
  'vima reports green checks with no reviewer configured, rather than spawning nothing silently',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = stateDirFor(repoRoot);
    const ticket = await genesis({ repoRoot, stateDir, content: 'task', planContent: '1. do it' });
    const config = baseConfig({ agents: { coder: COMMITTING_CODER } });

    await vima({ stateDir, id: ticket.id, repoRoot, config });
    await waitFor(
      () => backgroundStatus({ stateDir, id: ticket.id, role: 'coder' }).state === 'finished',
    );

    const result = await vima({ stateDir, id: ticket.id, repoRoot, config });
    assert.equal(result.action, 'none');
    assert.match(result.reason!, /no reviewer agent configured/);
  },
);

test(
  'vima respawns the coder automatically on a blocking verdict',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = stateDirFor(repoRoot);
    const ticket = await genesis({ repoRoot, stateDir, content: 'task', planContent: '1. do it' });
    const config = baseConfig({
      agents: {
        coder: COMMITTING_CODER,
        reviewer: `node "${BIN}" krisis ${ticket.id} --verdict blocking --finding "needs a fix"`,
      },
    });

    await vima({ stateDir, id: ticket.id, repoRoot, config });
    await waitFor(
      () => backgroundStatus({ stateDir, id: ticket.id, role: 'coder' }).state === 'finished',
    );
    await vima({ stateDir, id: ticket.id, repoRoot, config });
    await waitFor(
      () => backgroundStatus({ stateDir, id: ticket.id, role: 'reviewer' }).state === 'finished',
    );

    const result = await vima({ stateDir, id: ticket.id, repoRoot, config });
    assert.equal(result.action, 'spawned-coder');
    assert.match(result.reason!, /blocking findings/);
  },
);

// --------------------------------------------------------------------------- Watchdog tests. A stuck
// coder or reviewer must get killed, not left running. ergonTimeoutMs: -1 forces a timeout on the next check. ---------------------------------------------------------------------------

test(
  'vima kills a hung coder, records the timeout, and respawns on the next tick',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = stateDirFor(repoRoot);
    const ticket = await genesis({ repoRoot, stateDir, content: 'task', planContent: '1. do it' });

    const spawned = await vima({
      stateDir,
      id: ticket.id,
      repoRoot,
      config: baseConfig({ agents: { coder: 'sleep 30' } }),
    });
    assert.equal(spawned.action, 'spawned-coder');
    await waitFor(
      () => backgroundStatus({ stateDir, id: ticket.id, role: 'coder' }).state === 'running',
    );

    const killed = await vima({
      stateDir,
      id: ticket.id,
      repoRoot,
      config: baseConfig({ agents: { coder: 'sleep 30' }, ergonTimeoutMs: -1 }),
    });
    assert.equal(killed.action, 'none');
    assert.match(killed.reason!, /coder run timed out/);
    // Killing takes a moment. State shows "crashed" only after it is dead.
    await waitFor(
      () => backgroundStatus({ stateDir, id: ticket.id, role: 'coder' }).state === 'crashed',
    );

    const respawned = await vima({
      stateDir,
      id: ticket.id,
      repoRoot,
      config: baseConfig({ agents: { coder: 'true' } }),
    });
    assert.equal(respawned.action, 'spawned-coder');
    assert.match(respawned.reason!, /sent back to the coder/);
  },
);

test(
  "vima kills a hung reviewer and escalates instead of leaving it 'stalled' forever",
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = stateDirFor(repoRoot);
    const ticket = await genesis({ repoRoot, stateDir, content: 'task', planContent: '1. do it' });
    const config = baseConfig({ agents: { coder: COMMITTING_CODER, reviewer: 'sleep 30' } });

    await vima({ stateDir, id: ticket.id, repoRoot, config });
    await waitFor(
      () => backgroundStatus({ stateDir, id: ticket.id, role: 'coder' }).state === 'finished',
    );

    const spawnedReviewer = await vima({ stateDir, id: ticket.id, repoRoot, config });
    assert.equal(spawnedReviewer.action, 'spawned-reviewer');
    await waitFor(
      () => backgroundStatus({ stateDir, id: ticket.id, role: 'reviewer' }).state === 'running',
    );

    const killed = await vima({
      stateDir,
      id: ticket.id,
      repoRoot,
      config: { ...config, ergonTimeoutMs: -1 },
    });
    assert.equal(killed.action, 'none');
    assert.match(killed.reason!, /needs you/);
    await waitFor(
      () => backgroundStatus({ stateDir, id: ticket.id, role: 'reviewer' }).state === 'crashed',
    );
  },
);

// --------------------------------------------------------------------------- Tests for the round
// limit. We set up the stage log directly. A real loop of many rounds would just be slower, not more correct. ---------------------------------------------------------------------------

test(
  'vima stops and escalates once maxReviewRounds is reached on a blocking verdict',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = stateDirFor(repoRoot);
    const ticket = await genesis({ repoRoot, stateDir, content: 'task', planContent: '1. do it' });
    fs.writeFileSync(path.join(ticket.worktree!, 'a.txt'), 'a');
    execFileSync('git', ['add', 'a.txt'], { cwd: ticket.worktree! });
    execFileSync('git', ['commit', '-q', '-m', 'a'], { cwd: ticket.worktree! });

    // Both coder and reviewer must show as finished.
    // Otherwise vima starts a new one before we can test the limit.
    fakeFinishedCoder(stateDir, ticket.id);
    fakeFinishedRun(stateDir, ticket.id, 'reviewer');
    // Pretend one review round already ran, with a blocking issue still open.
    recordStage(stateDir, ticket.id, STAGES.REVIEW, RUN_OUTCOMES.OK);
    appendReviewFinding(stateDir, ticket.id, {
      verdict: REVIEW_VERDICT.BLOCKING,
      finding: 'still broken',
    });

    const config = baseConfig({ agents: { coder: 'true' }, maxReviewRounds: 1 });
    const result = await vima({ stateDir, id: ticket.id, repoRoot, config });

    assert.equal(result.action, 'none');
    assert.match(result.reason!, /max review rounds \(1\) reached/);
  },
);

test(
  'vima stops and escalates rather than re-reviewing once maxReviewRounds is already spent',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = stateDirFor(repoRoot);
    const ticket = await genesis({ repoRoot, stateDir, content: 'task', planContent: '1. do it' });
    fs.writeFileSync(path.join(ticket.worktree!, 'a.txt'), 'a');
    execFileSync('git', ['add', 'a.txt'], { cwd: ticket.worktree! });
    execFileSync('git', ['commit', '-q', '-m', 'a'], { cwd: ticket.worktree! });

    fakeFinishedCoder(stateDir, ticket.id);
    // One round is already used, and the coder ran again after that.
    // The next review attempt is the one the limit should block.
    recordStage(stateDir, ticket.id, STAGES.REVIEW, RUN_OUTCOMES.CHECKS_FAILED);
    recordStage(stateDir, ticket.id, STAGES.ERGON, RUN_OUTCOMES.OK);

    const config = baseConfig({ agents: { coder: 'true' }, maxReviewRounds: 1 });
    const result = await vima({ stateDir, id: ticket.id, repoRoot, config });

    assert.equal(result.action, 'none');
    assert.match(result.reason!, /max review rounds \(1\) reached/);
  },
);

// --------------------------------------------------------------------------- Notification tests.
// Should fire once per state, not once per check. ---------------------------------------------------------------------------

test(
  "vima's notifyCmd fires exactly once for a stable needs-you state, not on every tick",
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = stateDirFor(repoRoot);
    const ticket = await genesis({ repoRoot, stateDir, content: 'task', planContent: '1. do it' });
    recordAporia(stateDir, ticket.id, 'blocked');

    const marker = path.join(makeTempDir('notify'), 'fired');
    const config = baseConfig({ notifyCmd: `sh -c 'echo "$GLAFKA_MSG" >> "${marker}"'` });

    await vima({ stateDir, id: ticket.id, repoRoot, config });
    await vima({ stateDir, id: ticket.id, repoRoot, config });
    await vima({ stateDir, id: ticket.id, repoRoot, config });

    const fired = fs.readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(fired.length, 1);
    assert.match(fired[0], new RegExp(ticket.id));
    assert.equal(wasNotified(readTicket(stateDir, ticket.id)), true);
  },
);

// --------------------------------------------------------------------------- vimaAll
// ---------------------------------------------------------------------------

test('vimaAll ticks every active ticket, skipping closed ones', { concurrency: true }, async () => {
  const repoRoot = makeGitRepo();
  const stateDir = stateDirFor(repoRoot);
  const active = await genesis({ repoRoot, stateDir, content: 'task 1' });
  const closed = await genesis({ repoRoot, stateDir, content: 'task 2' });
  await lysis({ repoRoot, stateDir, id: closed.id, keep: 'all' });

  const results = await vimaAll({ stateDir, repoRoot, config: baseConfig() });

  assert.equal(results.length, 1);
  assert.equal(results[0].id, active.id);
});

// Before this fix, one broken ticket would stop all tickets from updating.
// This test checks that one bad ticket no longer blocks the others.
function driftPin(stateDir: string, id: string) {
  const file = ticketFiles(ticketsDir(stateDir), id).ticketFile;
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  stored.guardrails = { ...stored.guardrails, hash: '0000000000000000' };
  fs.writeFileSync(file, JSON.stringify(stored, null, 2));
}

test(
  'vimaAll isolates a throwing ticket and still ticks the rest',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = stateDirFor(repoRoot);
    const broken = await genesis({
      repoRoot,
      stateDir,
      content: 'task 1',
      planContent: '1. do it',
    });
    const healthy = await genesis({
      repoRoot,
      stateDir,
      content: 'task 2',
      planContent: '1. do it',
    });
    driftPin(stateDir, broken.id);

    const results = await vimaAll({
      stateDir,
      repoRoot,
      config: baseConfig({ agents: { coder: 'true' } }),
    });

    assert.equal(results.length, 2);
    const brokenResult = results.find((r) => r.id === broken.id);
    const healthyResult = results.find((r) => r.id === healthy.id);

    assert.equal(brokenResult!.action, 'error');
    assert.match(brokenResult!.reason!, /guardrails policy changed/);
    // Check that the healthy ticket still got its real action.
    assert.equal(healthyResult!.action, 'spawned-coder');
  },
);

// "error" and "none" are different. "none" means vima checked and did
// nothing on purpose. The exit code must show errors, so other tools notice.
test(
  'vima --all exits non-zero when a ticket errored, after ticking them all',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = stateDirFor(repoRoot);
    const broken = await genesis({
      repoRoot,
      stateDir,
      content: 'task 1',
      planContent: '1. do it',
    });
    const healthy = await genesis({
      repoRoot,
      stateDir,
      content: 'task 2',
      planContent: '1. do it',
    });
    driftPin(stateDir, broken.id);

    let status = 0;
    let stdout = '';
    try {
      stdout = execFileSync('node', [BIN, 'vima', '--all'], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: { ...process.env, GLAFKA_AGENT_CMD: 'true' },
      });
    } catch (err) {
      status = (err as { status: number }).status;
      stdout = (err as { stdout: string }).stdout;
    }

    assert.equal(status, 1);
    assert.match(stdout, new RegExp(`${broken.id}\\s+error`));
    // It got printed, so it was reached and the run did not stop early.
    assert.match(stdout, new RegExp(healthy.id));
  },
);

// --------------------------------------------------------------------------- Tests for past bugs, so
// they do not come back. ---------------------------------------------------------------------------

// Before this fix, any review error would restart the coder.
// A broken setup can't be fixed by more coding, so it kept restarting forever.
test(
  'a structural review failure asks for you instead of respawning the coder forever',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = stateDirFor(repoRoot);
    const ticket = await genesis({ repoRoot, stateDir, content: 'task', planContent: '1. do it' });
    execFileSync('git', ['add', '-A'], { cwd: ticket.worktree! });
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'work'], { cwd: ticket.worktree! });
    fakeFinishedCoder(stateDir, ticket.id);

    // Use a base branch that does not exist.
    // This is like a renamed branch or a deleted worktree.
    const config = baseConfig({ agents: { coder: 'sleep 30' }, baseRef: 'no-such-ref' });

    const actions: string[] = [];
    for (let i = 0; i < 4; i++) {
      const result = await vima({ stateDir, id: ticket.id, repoRoot, config });
      actions.push(result.action);
      if (result.pid) process.kill(result.pid, 'SIGKILL');
    }

    assert.deepEqual(
      actions,
      ['none', 'none', 'none', 'none'],
      'a structural failure must never respawn a coder',
    );
  },
);

// Even a failure worth retrying must stop at the round limit.
// This means each failed round must be counted.
test(
  'a coder-fixable review failure still counts as a round and hits the bound',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = stateDirFor(repoRoot);
    const ticket = await genesis({ repoRoot, stateDir, content: 'task', planContent: '1. do it' });
    fs.writeFileSync(path.join(ticket.worktree!, 'f.txt'), 'x\n');
    execFileSync('git', ['add', '-A'], { cwd: ticket.worktree! });
    execFileSync('git', ['commit', '-q', '-m', 'work'], { cwd: ticket.worktree! });
    fakeFinishedCoder(stateDir, ticket.id);

    // Failing checks can be fixed by the coder, so it restarts.
    // But it stops once the round limit is reached.
    const config = baseConfig({
      agents: { coder: 'true' },
      checksCmd: 'exit 1',
      maxReviewRounds: 2,
    });

    const actions: string[] = [];
    for (let i = 0; i < 4; i++) {
      const result = await vima({ stateDir, id: ticket.id, repoRoot, config });
      actions.push(result.action);
      await waitFor(
        () => backgroundStatus({ stateDir, id: ticket.id, role: 'coder' }).state !== 'running',
      );
    }

    assert.ok(actions.includes('spawned-coder'), 'a fixable failure is worth one more coder');
    assert.equal(actions.at(-1), 'none', 'and the loop must stop once the bound is reached');
    assert.ok(
      readTicket(stateDir, ticket.id).stageLog.filter((e) => e.stage === STAGES.REVIEW).length >= 2,
      'each failed round has to be recorded, or the bound can never be reached',
    );
  },
);

// Fakes a coder run that failed (exit code not 0).
function fakeFailedCoder(stateDir: string, id: string) {
  const { dir, pidPath, exitCodePath, logPath } = runFiles(stateDir, id, 'coder');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(pidPath, '999999');
  fs.writeFileSync(exitCodePath, '1');
  fs.writeFileSync(logPath, '');
}

// Before this fix, a failed or crashed coder run was not recorded at all.
// This let a half-finished branch pass review as if it were clean.
test(
  'a coder that exited non-zero is recorded as a bad run, not waved through to review',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = stateDirFor(repoRoot);
    const ticket = await genesis({ repoRoot, stateDir, content: 'task', planContent: '1. do it' });
    fs.writeFileSync(path.join(ticket.worktree!, 'half.txt'), 'half done\n');
    execFileSync('git', ['add', '-A'], { cwd: ticket.worktree! });
    execFileSync('git', ['commit', '-q', '-m', 'half the work'], { cwd: ticket.worktree! });
    fakeFailedCoder(stateDir, ticket.id);

    const result = await vima({
      stateDir,
      id: ticket.id,
      repoRoot,
      config: baseConfig({ agents: { coder: 'true', reviewer: 'true' } }),
    });

    assert.notEqual(result.action, 'spawned-reviewer', 'a failed run must not go to review');
    assert.ok(
      readTicket(stateDir, ticket.id).stageLog.some(
        (e) => e.stage === STAGES.ERGON && e.note === RUN_OUTCOMES.CRASHED,
      ),
      'the failed run has to be on the record, or the next tick reviews it as if it were fine',
    );
  },
);

// The stage log only grows, never shrinks. Adding an entry every check
// would wrongly mark the ticket as not reviewed anymore.
test(
  'repeat ticks on the same failed run record it once, not once per tick',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = stateDirFor(repoRoot);
    const ticket = await genesis({ repoRoot, stateDir, content: 'task', planContent: '1. do it' });
    fs.writeFileSync(path.join(ticket.worktree!, 'half.txt'), 'half\n');
    execFileSync('git', ['add', '-A'], { cwd: ticket.worktree! });
    execFileSync('git', ['commit', '-q', '-m', 'half'], { cwd: ticket.worktree! });
    fakeFailedCoder(stateDir, ticket.id);

    const config = baseConfig({ maxReviewRounds: 0 });
    const countCrashed = () =>
      readTicket(stateDir, ticket.id).stageLog.filter(
        (e) => e.stage === STAGES.ERGON && e.note === RUN_OUTCOMES.CRASHED,
      ).length;

    await vima({ stateDir, id: ticket.id, repoRoot, config });
    const afterFirst = countCrashed();
    await vima({ stateDir, id: ticket.id, repoRoot, config });
    await vima({ stateDir, id: ticket.id, repoRoot, config });

    assert.equal(afterFirst, 1);
    assert.equal(countCrashed(), 1, 'the same run must not be recorded again on later ticks');
  },
);

// Before this fix, one unreadable ticket file would stop the whole run.
// This test checks the fix works.
test(
  'one corrupt ticket file does not stop every other ticket from advancing',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = stateDirFor(repoRoot);
    const healthy = await genesis({
      repoRoot,
      stateDir,
      content: 'task',
      planContent: '1. do it',
    });
    const broken = await genesis({ repoRoot, stateDir, content: 'other', planContent: '1. x' });

    const { ticketFile } = ticketFiles(ticketsDir(stateDir), broken.id);
    fs.writeFileSync(ticketFile, '{"id":"' + broken.id + '","cont');

    const results = await vimaAll({
      stateDir,
      repoRoot,
      config: baseConfig({ agents: { coder: 'sleep 30' } }),
    });

    const healthyResult = results.find((r) => r.id === healthy.id);
    assert.equal(healthyResult?.action, 'spawned-coder', 'the healthy ticket must still advance');
    assert.ok(
      results.some((r) => r.action === 'error' && /unreadable ticket/.test(r.reason ?? '')),
      'and the skipped file must be reported, naming it',
    );
    if (healthyResult?.pid) process.kill(healthyResult.pid, 'SIGKILL');
  },
);

// Before this fix, a stuck notify command would freeze the whole run
// forever, blocking every ticket after it.
test('a notifyCmd that hangs is killed instead of stalling the loop', () => {
  const started = Date.now();
  runNotify('sleep 30', { id: '2026-08-07-a-hanging-notify-command', reason: 'x', timeoutMs: 500 });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 10_000, `runNotify returned in ${elapsed}ms, so it did not hang`);
});

test('a notifyCmd that finishes normally still runs', () => {
  const marker = path.join(makeTempDir('notify'), 'ran');
  runNotify(`touch ${JSON.stringify(marker)}`, {
    id: '2026-08-07-a-hanging-notify-command',
    reason: 'x',
  });
  assert.equal(fs.existsSync(marker), true);
});

// --------------------------------------------------------------------------- Resolving the id
// when none was typed. ---------------------------------------------------------------------------

test('runVima with no id resolves the only open ticket', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = stateDirFor(repoRoot);
  await genesis({ repoRoot, stateDir, content: 'task' });

  // No throw is the assertion: before this, a missing id was a usage error.
  await runVima({ args: [], stateDir, repoRoot, config: baseConfig() });
});

test('runVima with no id and two open tickets names both', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = stateDirFor(repoRoot);
  const first = createTicket({ repoRoot, stateDir, content: 'first task' });
  const second = createTicket({ repoRoot, stateDir, content: 'second task' });

  await assert.rejects(
    () => runVima({ args: [], stateDir, repoRoot, config: baseConfig() }),
    (err: Error) => err.message.includes(first.id) && err.message.includes(second.id),
  );
});

// --------------------------------------------------------------------------- The QA tester
// checks the acceptance criteria before any reviewer starts. ------------------------------------

const AC_SPEC = '# T\n\n## Acceptance criteria\n\n- AC-1: a → b → c\n';

// A fake QA tester. It reads the token from its prompt and records a pass.
const passingVerifier = (id: string) =>
  `token=$(grep -o -- "--token [0-9a-f]*" | head -1 | cut -d" " -f2); ` +
  `node "${BIN}" epalitheusis ${id} --ac AC-1 --result pass --evidence "echo hi → hi" --token "$token"`;

test(
  'vima runs the QA tester before the reviewer, then reaches ready',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = stateDirFor(repoRoot);
    const ticket = await genesis({ repoRoot, stateDir, content: AC_SPEC, planContent: '1. do it' });
    const config = baseConfig({
      agents: {
        coder: COMMITTING_CODER,
        verifier: passingVerifier(ticket.id),
        reviewer: cleanReviewer(ticket.id),
      },
    });

    await vima({ stateDir, id: ticket.id, repoRoot, config });
    await waitFor(
      () => backgroundStatus({ stateDir, id: ticket.id, role: 'coder' }).state === 'finished',
    );

    const verifying = await vima({ stateDir, id: ticket.id, repoRoot, config });
    assert.equal(verifying.action, 'spawned-verifier');
    await waitFor(
      () => backgroundStatus({ stateDir, id: ticket.id, role: 'verifier' }).state === 'finished',
    );

    const reviewing = await vima({ stateDir, id: ticket.id, repoRoot, config });
    assert.equal(reviewing.action, 'spawned-reviewer');
    await waitFor(
      () => backgroundStatus({ stateDir, id: ticket.id, role: 'reviewer' }).state === 'finished',
    );

    const ready = await vima({ stateDir, id: ticket.id, repoRoot, config });
    assert.equal(ready.action, 'ready');
  },
);

test('vima waits while the QA tester runs', { concurrency: true }, async () => {
  const repoRoot = makeGitRepo();
  const stateDir = stateDirFor(repoRoot);
  const ticket = await genesis({ repoRoot, stateDir, content: AC_SPEC, planContent: '1. do it' });
  const config = baseConfig({ agents: { coder: COMMITTING_CODER, verifier: 'sleep 30' } });

  try {
    await vima({ stateDir, id: ticket.id, repoRoot, config });
    await waitFor(
      () => backgroundStatus({ stateDir, id: ticket.id, role: 'coder' }).state === 'finished',
    );
    assert.equal(
      (await vima({ stateDir, id: ticket.id, repoRoot, config })).action,
      'spawned-verifier',
    );

    const waiting = await vima({ stateDir, id: ticket.id, repoRoot, config });
    assert.equal(waiting.reason, 'verifier still running');
  } finally {
    killBackground({ stateDir, id: ticket.id, role: 'verifier' });
  }
});

test('vima stops a QA tester that ran past the time limit', { concurrency: true }, async () => {
  const repoRoot = makeGitRepo();
  const stateDir = stateDirFor(repoRoot);
  const ticket = await genesis({ repoRoot, stateDir, content: AC_SPEC, planContent: '1. do it' });
  const config = baseConfig({
    agents: { coder: COMMITTING_CODER, verifier: 'sleep 30' },
    ergonTimeoutMs: 1500,
  });

  try {
    await vima({ stateDir, id: ticket.id, repoRoot, config });
    await waitFor(
      () => backgroundStatus({ stateDir, id: ticket.id, role: 'coder' }).state === 'finished',
    );
    assert.equal(
      (await vima({ stateDir, id: ticket.id, repoRoot, config })).action,
      'spawned-verifier',
    );

    // Polled, not slept: a fixed sleep against the limit flakes on a busy machine.
    await waitFor(
      () =>
        backgroundStatus({ stateDir, id: ticket.id, role: 'verifier', maxRuntimeMs: 1500 })
          .state === 'timed-out',
    );
    // The kill is the whole tick. Going on would read the dying run as live.
    const stopped = await vima({ stateDir, id: ticket.id, repoRoot, config });
    assert.deepEqual(stopped, {
      id: ticket.id,
      action: 'none',
      reason: 'verifier run timed out — stopped; the next tick closes its round',
    });

    await waitFor(
      () =>
        !['running', 'stalled'].includes(
          backgroundStatus({ stateDir, id: ticket.id, role: 'verifier' }).state,
        ),
    );
    const closing = await vima({ stateDir, id: ticket.id, repoRoot, config });
    assert.match(closing.reason!, /ended incomplete/);
    assert.equal(readTicket(stateDir, ticket.id).verification!.outcome, 'incomplete');
  } finally {
    killBackground({ stateDir, id: ticket.id, role: 'verifier' });
  }
});

test(
  'vima with AC but no verifier agent says to verify by hand',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = stateDirFor(repoRoot);
    const ticket = await genesis({ repoRoot, stateDir, content: AC_SPEC, planContent: '1. do it' });
    const config = baseConfig({ agents: { coder: COMMITTING_CODER } });

    await vima({ stateDir, id: ticket.id, repoRoot, config });
    await waitFor(
      () => backgroundStatus({ stateDir, id: ticket.id, role: 'coder' }).state === 'finished',
    );
    const result = await vima({ stateDir, id: ticket.id, repoRoot, config });
    assert.equal(result.action, 'none');
    assert.match(result.reason!, /no verifier agent configured/);
  },
);

// A fake QA tester that records one result with no token. A fail or a cannot needs none.
const recordingVerifier = (id: string, result: 'fail' | 'cannot') =>
  `cat > /dev/null; node "${BIN}" epalitheusis ${id} --ac AC-1 --result ${result} --evidence "curl /x → 500"`;

// Runs the coder, then the QA tester, and returns the tick after the tester ended.
async function tickAfterVerifier(result: 'fail' | 'cannot') {
  const repoRoot = makeGitRepo();
  const stateDir = stateDirFor(repoRoot);
  const ticket = await genesis({ repoRoot, stateDir, content: AC_SPEC, planContent: '1. do it' });
  const config = baseConfig({
    agents: { coder: COMMITTING_CODER, verifier: recordingVerifier(ticket.id, result) },
  });
  const id = ticket.id;
  await vima({ stateDir, id, repoRoot, config });
  await waitFor(() => backgroundStatus({ stateDir, id, role: 'coder' }).state === 'finished');
  assert.equal((await vima({ stateDir, id, repoRoot, config })).action, 'spawned-verifier');
  await waitFor(() => backgroundStatus({ stateDir, id, role: 'verifier' }).state === 'finished');
  const after = await vima({ stateDir, id, repoRoot, config });
  return { repoRoot, stateDir, id, config, after };
}

test(
  'vima sends a failed acceptance criterion back to a coder',
  { concurrency: true },
  async () => {
    const { stateDir, id, after } = await tickAfterVerifier('fail');
    try {
      assert.equal(after.action, 'spawned-coder');
      assert.match(after.reason!, /acceptance criteria failed — AC-1 failed: curl \/x → 500/);
    } finally {
      killBackground({ stateDir, id, role: 'coder' });
    }
  },
);

test(
  'vima stops for a person when a criterion cannot be checked',
  { concurrency: true },
  async () => {
    const { repoRoot, stateDir, id, config, after } = await tickAfterVerifier('cannot');
    assert.equal(after.action, 'none');
    const next = await vima({ stateDir, id, repoRoot, config });
    assert.equal(next.action, 'none');
    assert.match(next.reason!, /needs you — epalitheusis: AC-1 cannot be checked/);
  },
);

// The previous round's reviewer said blocking. A QA round that then ends blocked must stop
// vima, not let it read that old log line and pay for a coder with stale findings.
test(
  'a blocked QA round stops vima, even when an old reviewer log says blocking',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = stateDirFor(repoRoot);
    const ticket = await genesis({ repoRoot, stateDir, content: AC_SPEC, planContent: '1. do it' });
    const id = ticket.id;
    const worktree = ticket.worktree!;
    fs.writeFileSync(path.join(worktree, 'done.txt'), 'x\n');
    execFileSync('git', ['add', 'done.txt'], { cwd: worktree });
    execFileSync('git', ['commit', '-q', '-m', 'did it'], { cwd: worktree });
    recordStage(stateDir, id, STAGES.ERGON);
    recordStage(stateDir, id, STAGES.REVIEW, RUN_OUTCOMES.OK);
    fakeFinishedRun(stateDir, id, 'reviewer');
    fs.writeFileSync(runFiles(stateDir, id, 'reviewer').logPath, 'VERDICT: blocking — stale\n');
    recordStage(stateDir, id, STAGES.ERGON);
    fakeFinishedCoder(stateDir, id);
    // This round's QA tester ran and recorded nothing.
    openVerifyRound(stateDir, id, { token: 'tok', ...codeState(worktree), spawned: true });
    fakeFinishedRun(stateDir, id, 'verifier');
    const config = baseConfig({ agents: { coder: COMMITTING_CODER } });

    try {
      const first = await vima({ stateDir, id, repoRoot, config });
      assert.equal(first.action, 'none');
      assert.match(first.reason!, /ended incomplete/);
      const second = await vima({ stateDir, id, repoRoot, config });
      assert.equal(second.action, 'none');
      assert.match(
        second.reason!,
        /^acceptance criteria: the last verification round ended incomplete: .* — needs you$/,
      );
    } finally {
      killBackground({ stateDir, id, role: 'coder' });
    }
  },
);

// M13: a ticket not reviewed yet, a QA tester that always fails, and a coder that commits a
// fix each time. maxReviewRounds counts each QA → coder trip, so the paid runs stop.
test(
  'an AC that always fails stops at maxReviewRounds, however many ticks run',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = stateDirFor(repoRoot);
    const ticket = await genesis({ repoRoot, stateDir, content: AC_SPEC, planContent: '1. do it' });
    const id = ticket.id;
    const coder = `sh -c 'f=fix-$$.txt; echo x > $f && git add $f && git commit -q -m fix'`;
    const agents = { coder, verifier: recordingVerifier(id, 'fail'), reviewer: 'cat > /dev/null' };
    const config = baseConfig({ agents, maxReviewRounds: 2 });
    const roles = ['coder', 'verifier', 'reviewer'];
    const settled = () =>
      roles.every(
        (role) => !['running', 'stalled'].includes(backgroundStatus({ stateDir, id, role }).state),
      );
    const results: Awaited<ReturnType<typeof vima>>[] = [];
    try {
      for (let i = 0; i < 22; i++) {
        results.push(await vima({ stateDir, id, repoRoot, config }));
        await waitFor(settled);
      }
      const spawned = (action: string) => results.filter((r) => r.action === action).length;
      // The first coder, then one fix: the second failed round is the last one allowed.
      assert.equal(spawned('spawned-coder'), 2);
      assert.equal(spawned('spawned-verifier'), 2);
      assert.equal(spawned('spawned-reviewer'), 0);
      const stop = results.findIndex((r) => /max review rounds \(2\) reached/.test(r.reason ?? ''));
      assert.ok(stop !== -1, 'the max-rounds stop was never reached');
      assert.deepEqual(
        results.slice(stop).filter((r) => r.action !== 'none'),
        [],
      );
    } finally {
      for (const role of roles) killBackground({ stateDir, id, role });
    }
  },
);
