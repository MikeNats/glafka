import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeGitRepo } from '../helpers/gitFixture.js';
import { genesis } from '../../src/commands/genesis/genesis.js';
import { ergonBackground, ergonStatus, ergonReview } from '../../src/commands/ergon/ergon.js';
import { isAlive, backgroundStatus } from '../../src/ticket/background.js';
import { runFiles } from '../../src/ticket/paths.js';
import { makeTempDir } from '../helpers/tempDir.js';
import {
  lastRunFailed,
  lastRunOutcome,
  RUN_OUTCOMES,
  readTicket,
  isReviewedSinceLastChange,
} from '../../src/ticket/ticketStore.js';

function tempStateDir() {
  return makeTempDir('state');
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

// No package.json means no checks ran. That is not the same as passing.
test(
  'a run where no checks existed is recorded as unknown, not as passed',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'task', planContent: '1. do it' });

    await ergonBackground({ stateDir, id: ticket.id, repoRoot, agentCmd: 'cat' });

    return waitFor(() => backgroundStatus({ stateDir, id: ticket.id }).state !== 'running').then(
      async () => {
        const result = await ergonStatus({ stateDir, id: ticket.id });
        assert.equal(result.status.state, 'finished');
        assert.deepEqual(result.checks, []);
        assert.equal(lastRunOutcome(result.ticket), RUN_OUTCOMES.CHECKS_UNKNOWN);
        // "Unknown" shows up but does not block. Many repos have no checks.
        assert.equal(lastRunFailed(result.ticket), false);
      },
    );
  },
);

test('a run whose real checks actually pass is recorded as ok', { concurrency: true }, async () => {
  const repoRoot = makeGitRepo();
  const stateDir = tempStateDir();
  const ticket = await genesis({ repoRoot, stateDir, content: 'task', planContent: '1. do it' });

  fs.writeFileSync(
    path.join(ticket.worktree!, 'package.json'),
    JSON.stringify({ name: 'x', scripts: { test: 'exit 0' } }),
  );

  await ergonBackground({ stateDir, id: ticket.id, repoRoot, agentCmd: 'true' });

  return waitFor(() => backgroundStatus({ stateDir, id: ticket.id }).state !== 'running').then(
    async () => {
      const result = await ergonStatus({ stateDir, id: ticket.id });
      assert.equal(result.checks[0].passed, true);
      assert.equal(lastRunOutcome(result.ticket), RUN_OUTCOMES.OK);
      assert.equal(lastRunFailed(result.ticket), false);
    },
  );
});

// Glafka ran package.json's own scripts on the host, unattended, before ANYTHING
// warned about that exact file. `--status` is the second trigger the finding names (the first is ergonReview). Passing repoRoot is what activates the guard; without it (see the tests above, which don't pass it) nothing changes.
test(
  "ergonStatus refuses the npm fallback when the coder's own commit added package.json",
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'task', planContent: '1. do it' });

    fs.writeFileSync(
      path.join(ticket.worktree!, 'package.json'),
      JSON.stringify({ name: 'x', scripts: { test: 'echo should-not-run' } }),
    );
    execFileSync('git', ['add', 'package.json'], { cwd: ticket.worktree! });
    execFileSync('git', ['commit', '-q', '-m', 'add package.json'], { cwd: ticket.worktree! });

    await ergonBackground({ stateDir, id: ticket.id, repoRoot, agentCmd: 'true' });

    return waitFor(() => backgroundStatus({ stateDir, id: ticket.id }).state !== 'running').then(
      async () => {
        const result = await ergonStatus({ stateDir, id: ticket.id, repoRoot, baseRef: 'main' });
        assert.equal(result.checks.length, 1);
        // Named `package.json`, because that is the guard doing the work at this level. The wider
        // hostexec guard sits in front of both branches and covers a configured `checksCmd` too, but
        // it now answers to `flagHostExecutingChanges`, which the DEFAULT level turns off — level 0
        // promises no cage and used to hand out a checks gate nothing could move. This narrower
        // guard is unconditional, so package.json's own scripts are still never run unattended.
        assert.equal(result.checks[0].name, 'package.json');
        assert.equal(result.checks[0].unknown, true);
        assert.equal(result.checks[0].passed, false);
        assert.match(result.checks[0].output, /package\.json/);
        assert.doesNotMatch(result.checks[0].output, /should-not-run/);
      },
    );
  },
);

test(
  'a finished run whose real checks fail leaves the ticket needing attention',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'task', planContent: '1. do it' });

    fs.writeFileSync(
      path.join(ticket.worktree!, 'package.json'),
      JSON.stringify({ name: 'x', scripts: { test: 'exit 1' } }),
    );

    // glafka does not trust the agent saying "done". It runs the real checks itself.
    await ergonBackground({ stateDir, id: ticket.id, repoRoot, agentCmd: 'true' });

    return waitFor(() => backgroundStatus({ stateDir, id: ticket.id }).state !== 'running').then(
      async () => {
        const result = await ergonStatus({ stateDir, id: ticket.id });
        assert.equal(result.status.state, 'finished');
        assert.equal(lastRunFailed(result.ticket), true);
        // This says exactly what went wrong: checks failed, not a crash.
        assert.equal(lastRunOutcome(result.ticket), RUN_OUTCOMES.CHECKS_FAILED);
        assert.equal(result.checks[0].passed, false);
      },
    );
  },
);

test(
  "ergonStatus's hard gate uses a configured checksCmd instead of package.json auto-detection",
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'task', planContent: '1. do it' });

    await ergonBackground({ stateDir, id: ticket.id, repoRoot, agentCmd: 'true' });

    return waitFor(() => backgroundStatus({ stateDir, id: ticket.id }).state !== 'running').then(
      async () => {
        const result = await ergonStatus({ stateDir, id: ticket.id, checksCmd: 'exit 1' });
        assert.equal(lastRunFailed(result.ticket), true);
        assert.equal(lastRunOutcome(result.ticket), RUN_OUTCOMES.CHECKS_FAILED);
        assert.deepEqual(
          result.checks.map((c) => c.name),
          ['checks'],
        );
      },
    );
  },
);

test(
  'ergonBackground refuses to start a second run while one is still going',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'task', planContent: '1. do it' });

    const { pid } = await ergonBackground({
      stateDir,
      id: ticket.id,
      repoRoot,
      agentCmd: 'sleep 30',
    });

    await assert.rejects(
      () => ergonBackground({ stateDir, id: ticket.id, repoRoot, agentCmd: 'true' }),
      /already has a background run in progress/,
    );

    process.kill(pid!, 'SIGKILL');
    return waitFor(() => !isAlive(pid!));
  },
);

// The check ("is a run already going?") and the spawn used to be two separate
// moments, with nothing stopping two overlapping `vima` ticks (two separate processes) from both reading "not-started" before either had written a pid file. Both would spawn a coder into the same worktree. A file lock now wraps the whole check-then-spawn sequence, so even a process caught mid-spawn (lock held, pid not written yet) blocks a second one rather than letting it through.
test(
  'ergonBackground refuses to spawn while another spawn is mid-flight, not just while a pid is on file',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'task', planContent: '1. do it' });

    // Stands in for a first `vima` tick that has passed its own "not-started" check and is about to
    // spawn, but has not yet written a pid file — the exact gap the old code left open.
    const { dir, lockPath } = runFiles(stateDir, ticket.id, 'coder');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), {
      flag: 'wx',
    });

    await assert.rejects(
      () => ergonBackground({ stateDir, id: ticket.id, repoRoot, agentCmd: 'true' }),
      /still locked/,
    );

    // Nothing was spawned while the lock was held — the second tick did
    // not race past the first and write its own pid over it.
    assert.equal(backgroundStatus({ stateDir, id: ticket.id }).state, 'not-started');

    fs.unlinkSync(lockPath);
  },
);

test(
  'the spawn lock does not leak — a normal spawn removes it, and does not block the next real check',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'task', planContent: '1. do it' });
    const { lockPath } = runFiles(stateDir, ticket.id, 'coder');

    const { pid } = await ergonBackground({
      stateDir,
      id: ticket.id,
      repoRoot,
      agentCmd: 'sleep 30',
    });

    assert.equal(fs.existsSync(lockPath), false);
    await assert.rejects(
      () => ergonBackground({ stateDir, id: ticket.id, repoRoot, agentCmd: 'true' }),
      /already has a background run in progress/,
    );
    assert.equal(fs.existsSync(lockPath), false);

    process.kill(pid!, 'SIGKILL');
    return waitFor(() => !isAlive(pid!));
  },
);

// The two tests above take the contention apart and drive each half on its own.
// This one lets two real starts overlap, which is the shape the loop hits.
test(
  'two starts racing each other leave exactly one run going',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'task', planContent: '1. do it' });
    const { lockPath } = runFiles(stateDir, ticket.id, 'coder');

    // Started together, never awaited one after the other: both pass their own
    // "is a run going?" check before either has written a pid.
    const results = await Promise.allSettled([
      ergonBackground({ stateDir, id: ticket.id, repoRoot, agentCmd: 'sleep 30' }),
      ergonBackground({ stateDir, id: ticket.id, repoRoot, agentCmd: 'sleep 30' }),
    ]);

    const won = results.filter((result) => result.status === 'fulfilled');
    const lost = results.filter((result) => result.status === 'rejected');
    assert.equal(won.length, 1, 'two coders were started into one worktree');
    // Either half of the guard is a correct answer: the lock refused it, or the
    // lock let it in and it found the pid the winner had already written.
    assert.match(
      String((lost[0] as PromiseRejectedResult).reason.message),
      /already has a background run in progress|still locked/,
    );
    // Nothing is left holding the ticket after a lost race.
    assert.equal(fs.existsSync(lockPath), false);

    const pid = (won[0] as PromiseFulfilledResult<{ pid?: number }>).value.pid;
    process.kill(pid!, 'SIGKILL');
    return waitFor(() => !isAlive(pid!));
  },
);

test(
  'ergonBackground can start again once the previous run has actually finished',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'task', planContent: '1. do it' });

    await ergonBackground({ stateDir, id: ticket.id, repoRoot, agentCmd: 'true' });

    return waitFor(() => backgroundStatus({ stateDir, id: ticket.id }).state !== 'running').then(
      async () => {
        // A clean finish needs no attention, so a new run can start.
        await ergonBackground({ stateDir, id: ticket.id, repoRoot, agentCmd: 'true' });
      },
    );
  },
);

test(
  'a crashed background run leaves the ticket needing attention',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'task', planContent: '1. do it' });

    const { pid } = await ergonBackground({
      stateDir,
      id: ticket.id,
      repoRoot,
      agentCmd: 'sleep 30',
    });
    process.kill(pid!, 'SIGKILL');

    return waitFor(() => !isAlive(pid!)).then(async () => {
      const result = await ergonStatus({ stateDir, id: ticket.id });
      assert.equal(result.status.state, 'crashed');
      assert.equal(lastRunFailed(result.ticket), true);
      // A dead process is different from a run that finished but failed checks.
      assert.equal(lastRunOutcome(result.ticket), RUN_OUTCOMES.CRASHED);
    });
  },
);

test(
  'ergonStatus reports real commit progress since the planned baseline',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({
      repoRoot,
      stateDir,
      content: 'task',
      planContent: '1. do it\n2. do more',
    });

    fs.writeFileSync(path.join(ticket.worktree!, 'step1.txt'), 'step 1\n');
    execFileSync('git', ['add', 'step1.txt'], { cwd: ticket.worktree! });
    execFileSync('git', ['commit', '-q', '-m', 'finish step 1'], { cwd: ticket.worktree! });

    const result = await ergonStatus({ stateDir, id: ticket.id });

    assert.equal(result.progress!.commits, 1);
    assert.equal(result.progress!.latestCommit, 'finish step 1');
    assert.equal(result.progress!.uncommittedChanges, false);
  },
);

test(
  'ergonStatus flags uncommitted changes — a step likely got interrupted mid-way',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'task', planContent: '1. do it' });

    fs.writeFileSync(path.join(ticket.worktree!, 'half-done.txt'), 'not committed yet\n');

    const result = await ergonStatus({ stateDir, id: ticket.id });

    assert.equal(result.progress!.commits, 0);
    assert.equal(result.progress!.latestCommit, null);
    assert.equal(result.progress!.uncommittedChanges, true);
  },
);

test(
  "ergonStatus's progress is null for a ticket with no planned baseline",
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    // No planContent means genesis never saves a planCommit.
    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });

    const result = await ergonStatus({ stateDir, id: ticket.id });

    assert.equal(result.progress, null);
  },
);

// `--status` must be safe to check many times. It must not undo a
// review that already happened.
test(
  'polling ergon --status again after a review does not un-review the ticket',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'task', planContent: '1. do it' });
    fs.writeFileSync(path.join(ticket.worktree!, 'a.txt'), 'a\n');
    execFileSync('git', ['add', 'a.txt'], { cwd: ticket.worktree! });
    execFileSync('git', ['commit', '-q', '-m', 'add a'], { cwd: ticket.worktree! });

    await ergonBackground({ stateDir, id: ticket.id, repoRoot, agentCmd: 'true' });

    await waitFor(() => backgroundStatus({ stateDir, id: ticket.id }).state !== 'running');
    await ergonStatus({ stateDir, id: ticket.id }); // first check

    await ergonReview({ stateDir, id: ticket.id, repoRoot, baseRef: 'main' });
    assert.equal(isReviewedSinceLastChange(readTicket(stateDir, ticket.id)), true);

    // Check again, same run, same commit.
    await ergonStatus({ stateDir, id: ticket.id });

    assert.equal(isReviewedSinceLastChange(readTicket(stateDir, ticket.id)), true);
  },
);

// Same kind of bug: leftover files after a finished run must also
// not undo a review.
test(
  'polling ergon --status again on a finished-but-dirty run does not un-review the ticket',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'task', planContent: '1. do it' });
    fs.writeFileSync(path.join(ticket.worktree!, 'a.txt'), 'a\n');
    execFileSync('git', ['add', 'a.txt'], { cwd: ticket.worktree! });
    execFileSync('git', ['commit', '-q', '-m', 'add a'], { cwd: ticket.worktree! });

    await ergonBackground({ stateDir, id: ticket.id, repoRoot, agentCmd: 'true' });
    await waitFor(() => backgroundStatus({ stateDir, id: ticket.id }).state !== 'running');

    // A file left behind after the run finished. This makes the worktree dirty.
    fs.writeFileSync(path.join(ticket.worktree!, 'coverage.txt'), 'stray\n');

    await ergonStatus({ stateDir, id: ticket.id }); // first check
    await ergonReview({ stateDir, id: ticket.id, repoRoot, baseRef: 'main' });
    assert.equal(isReviewedSinceLastChange(readTicket(stateDir, ticket.id)), true);

    // Check twice more, same finished, still-dirty run.
    await ergonStatus({ stateDir, id: ticket.id });
    await ergonStatus({ stateDir, id: ticket.id });

    const finalTicket = readTicket(stateDir, ticket.id);
    assert.equal(isReviewedSinceLastChange(finalTicket), true);
    assert.equal(finalTicket.stageLog.filter((e) => e.stage === 'ergon').length, 2);
  },
);

// A new run must record its own result, even if an old marker
// from a past run is still on disk.
test(
  'a second run after a finished one still records its own outcome',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'task', planContent: '1. do it' });

    await ergonBackground({ stateDir, id: ticket.id, repoRoot, agentCmd: 'true' });
    await waitFor(() => backgroundStatus({ stateDir, id: ticket.id }).state !== 'running');
    await ergonStatus({ stateDir, id: ticket.id });
    const ergonCountFirst = readTicket(stateDir, ticket.id).stageLog.filter(
      (e) => e.stage === 'ergon',
    ).length;

    await ergonBackground({ stateDir, id: ticket.id, repoRoot, agentCmd: 'true' });
    await waitFor(() => backgroundStatus({ stateDir, id: ticket.id }).state !== 'running');
    await ergonStatus({ stateDir, id: ticket.id });
    const ergonCountSecond = readTicket(stateDir, ticket.id).stageLog.filter(
      (e) => e.stage === 'ergon',
    ).length;

    assert.ok(ergonCountSecond > ergonCountFirst);
  },
);

// Checks the fix works end to end, by reading the real prompt file the coder gets.
test(
  "a background run's real prompt tells the coder to stop, not to review itself",
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'task', planContent: '1. do it' });

    await ergonBackground({ stateDir, id: ticket.id, repoRoot, agentCmd: 'true' });

    const promptPath = runFiles(stateDir, ticket.id, 'coder').promptPath;
    const prompt = fs.readFileSync(promptPath, 'utf8');
    assert.doesNotMatch(prompt, /don't stop yet/);
    assert.match(prompt, /stop here — do not run/);

    await waitFor(() => backgroundStatus({ stateDir, id: ticket.id }).state !== 'running');
  },
);
