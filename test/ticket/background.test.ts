import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeTempDir } from '../helpers/tempDir.js';
import {
  isAlive,
  spawnBackground,
  backgroundStatus,
  killBackground,
  markExternalRunStarted,
  hasPidFile,
  assertNoLiveRun,
  markOutcomeRecorded,
  reapOrphans,
  RUNNING_STATES,
} from '../../src/ticket/background.js';
import { runFiles } from '../../src/ticket/paths.js';
import { readRunRecords, recordPath } from '../../src/audit/record.js';
import { loadLevel } from '../../installKit/guardrails/resolve.js';
import type { Policy } from '../../installKit/guardrails/types/policy.js';

function tempStateDir() {
  return makeTempDir('bg');
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

test("isAlive is true for the current process and false for a pid that doesn't exist", async () => {
  assert.equal(isAlive(process.pid), true);
  assert.equal(isAlive(999999), false);
});

test('backgroundStatus is not-started before anything is spawned', async () => {
  const stateDir = tempStateDir();
  assert.deepEqual(backgroundStatus({ stateDir, id: '2026-08-03-a-stored-ticket' }), {
    state: 'not-started',
  });
});

test('spawnBackground and backgroundStatus refuse a path-traversal id', async () => {
  const stateDir = tempStateDir();

  assert.throws(
    () => spawnBackground({ stateDir, id: '../../etc', agentCmd: 'true', prompt: '' }),
    /invalid ticket id/,
  );
  assert.throws(() => backgroundStatus({ stateDir, id: '../../etc' }), /invalid ticket id/);
});

test('backgroundStatus reports timed-out for a run still alive past maxRuntimeMs, and it stays running without a limit', async () => {
  const stateDir = tempStateDir();
  const pid = spawnBackground({
    stateDir,
    id: '2026-08-03-a-stored-ticket',
    agentCmd: 'sleep 30',
    prompt: '',
  }).pid!;

  return waitFor(() => isAlive(pid)).then(() => {
    const unbounded = backgroundStatus({ stateDir, id: '2026-08-03-a-stored-ticket' });
    assert.equal(unbounded.state, 'running');

    // We use -1, not 0. A fast test could measure exactly 0ms.
    // -1 always counts as "past the limit", no matter the speed.
    const bounded = backgroundStatus({
      stateDir,
      id: '2026-08-03-a-stored-ticket',
      maxRuntimeMs: -1,
    });
    assert.equal(bounded.state, 'timed-out');
    assert.equal(bounded.pid, pid);

    process.kill(pid, 'SIGKILL');
  });
});

test('a clean, successful run reports finished with exit code 0 and the real prompt in the log', async () => {
  const stateDir = tempStateDir();

  spawnBackground({
    stateDir,
    id: '2026-08-03-a-stored-ticket',
    agentCmd: 'cat',
    prompt: 'hello from the prompt',
  });

  return waitFor(
    () => backgroundStatus({ stateDir, id: '2026-08-03-a-stored-ticket' }).state === 'finished',
  ).then(() => {
    const status = backgroundStatus({ stateDir, id: '2026-08-03-a-stored-ticket' });
    assert.equal(status.state, 'finished');
    assert.equal(status.exitCode, 0);
    assert.match(fs.readFileSync(status.logPath, 'utf8'), /hello from the prompt/);
  });
});

// The spawning process is gone by the time a background run's outcome is
// read, so the agent name has to be on disk, not held in memory.
test('spawnBackground writes the agent name to disk, by program name only', async () => {
  const stateDir = tempStateDir();

  spawnBackground({
    stateDir,
    id: '2026-08-03-a-stored-ticket',
    agentCmd: 'cat --unbuffered',
    prompt: '',
  });

  const { agentPath } = runFiles(stateDir, '2026-08-03-a-stored-ticket');
  assert.equal(fs.readFileSync(agentPath, 'utf8'), 'cat');
});

// markOutcomeRecorded is the only place a background run's cost gets filed —
// this checks the disk-read path end to end, agent name through to tokens.
test('markOutcomeRecorded with observability on files a real audit record', async () => {
  const stateDir = tempStateDir();
  const id = '2026-08-03-a-stored-ticket';
  const usage = JSON.stringify({ usage: { input_tokens: 12, output_tokens: 3 } });

  spawnBackground({ stateDir, id, agentCmd: `printf '%s' ${JSON.stringify(usage)}`, prompt: '' });
  await waitFor(() => backgroundStatus({ stateDir, id }).state === 'finished');

  markOutcomeRecorded({ stateDir, id, observability: true });

  const [rec] = readRunRecords(stateDir, id);
  assert.equal(rec!.stage, 'ergon');
  assert.equal(rec!.agent, 'printf');
  assert.equal(rec!.exitCode, 0);
  assert.deepEqual(rec!.tokens, { in: 12, out: 3 });
});

// The default: a caller that has not been updated to pass observability must
// not silently start filing records with the wrong stage or role.
test('markOutcomeRecorded with no observability argument records nothing', async () => {
  const stateDir = tempStateDir();
  const id = '2026-08-03-a-stored-ticket';

  spawnBackground({ stateDir, id, agentCmd: 'true', prompt: '' });
  await waitFor(() => backgroundStatus({ stateDir, id }).state === 'finished');

  markOutcomeRecorded({ stateDir, id });

  assert.equal(fs.existsSync(recordPath(stateDir, id)), false);
});

test('a command that exits nonzero reports failed, not finished', async () => {
  const stateDir = tempStateDir();

  spawnBackground({ stateDir, id: '2026-08-03-a-stored-ticket', agentCmd: 'exit 1', prompt: '' });

  return waitFor(
    () => backgroundStatus({ stateDir, id: '2026-08-03-a-stored-ticket' }).state === 'failed',
  ).then(() => {
    const status = backgroundStatus({ stateDir, id: '2026-08-03-a-stored-ticket' });
    assert.equal(status.state, 'failed');
    assert.equal(status.exitCode, 1);
  });
});

test('killing the process before it writes its exit code reports crashed', async () => {
  const stateDir = tempStateDir();

  const pid = spawnBackground({
    stateDir,
    id: '2026-08-03-a-stored-ticket',
    agentCmd: 'sleep 30',
    prompt: '',
  }).pid!;
  process.kill(pid, 'SIGKILL');

  return waitFor(() => !isAlive(pid)).then(() => {
    const status = backgroundStatus({ stateDir, id: '2026-08-03-a-stored-ticket' });
    assert.equal(status.state, 'crashed');
  });
});

test('killBackground signals the real process, which then reports cancelled (a stop you chose, not a crash)', async () => {
  const stateDir = tempStateDir();
  const pid = spawnBackground({
    stateDir,
    id: '2026-08-03-a-stored-ticket',
    agentCmd: 'sleep 30',
    prompt: '',
  }).pid!;

  return waitFor(() => isAlive(pid)).then(() => {
    const killed = killBackground({ stateDir, id: '2026-08-03-a-stored-ticket' });
    assert.equal(killed, true);

    return waitFor(() => !isAlive(pid)).then(() => {
      assert.equal(
        backgroundStatus({ stateDir, id: '2026-08-03-a-stored-ticket' }).state,
        'cancelled',
        'a stop someone chose must not read as a crash',
      );
    });
  });
});

// The bug: killing only the main process left its child process running.
// This test checks that killing now stops the child too.
test('killBackground kills the whole process group, not just the recorded pid', async () => {
  const stateDir = tempStateDir();
  const grandchildPidFile = path.join(makeTempDir('gc'), 'pid');

  const pid = spawnBackground({
    stateDir,
    id: '2026-08-03-a-stored-ticket',
    agentCmd: `sleep 30 & echo $! > ${grandchildPidFile}; wait`,
    prompt: '',
  }).pid!;

  await waitFor(
    () =>
      fs.existsSync(grandchildPidFile) && fs.readFileSync(grandchildPidFile, 'utf8').trim() !== '',
  );
  const grandchildPid = Number(fs.readFileSync(grandchildPidFile, 'utf8').trim());
  await waitFor(() => isAlive(grandchildPid));

  killBackground({ stateDir, id: '2026-08-03-a-stored-ticket' });

  await waitFor(() => !isAlive(pid));
  assert.equal(
    isAlive(grandchildPid),
    false,
    'the grandchild sleep must die along with the wrapper',
  );
});

test('killBackground is a harmless no-op once the run has already finished', async () => {
  const stateDir = tempStateDir();
  spawnBackground({ stateDir, id: '2026-08-03-a-stored-ticket', agentCmd: 'true', prompt: '' });

  return waitFor(
    () => backgroundStatus({ stateDir, id: '2026-08-03-a-stored-ticket' }).state === 'finished',
  ).then(() => {
    assert.equal(killBackground({ stateDir, id: '2026-08-03-a-stored-ticket' }), false);
  });
});

test('killBackground on a ticket that never had a background run is a harmless no-op', async () => {
  const stateDir = tempStateDir();
  assert.equal(killBackground({ stateDir, id: '2026-08-03-a-stored-ticket' }), false);
});

// The check is `age > staleMs`, so staleMs: 0 was a coin flip on the tie.
// We age the log for real instead, which is the thing being tested anyway.
test('a running process with a silent log past staleMs reports stalled', async () => {
  const stateDir = tempStateDir();

  const pid = spawnBackground({
    stateDir,
    id: '2026-08-03-a-stored-ticket',
    // It prints before it sleeps, so we can tell when the log is settled.
    agentCmd: 'echo up; sleep 30',
    prompt: '',
  }).pid!;

  const { logPath } = runFiles(stateDir, '2026-08-03-a-stored-ticket');

  // The wrapper's `>` truncates the log and bumps its mtime, so backdating
  // before the output lands would just be undone.
  return waitFor(() => isAlive(pid) && fs.readFileSync(logPath, 'utf8').includes('up')).then(() => {
    const longAgo = new Date(Date.now() - 60_000);
    fs.utimesSync(logPath, longAgo, longAgo);

    const status = backgroundStatus({ stateDir, id: '2026-08-03-a-stored-ticket', staleMs: 1000 });
    assert.equal(status.state, 'stalled');
    process.kill(pid, 'SIGKILL');
  });
});

// A process owned by another user still exists, we just can't signal it.
// We must not treat that as "dead", or a working run looks crashed.
test('isAlive treats a process it may not signal as alive, not dead', () => {
  // pid 1 is a system process. It always runs, and we can't signal it.
  assert.equal(isAlive(1), true);
});

// A coder run and a reviewer run on the same ticket must not mix up.
// Each one gets its own files and is tracked separately.
test('a coder run and a reviewer run on the same ticket are tracked independently', async () => {
  const stateDir = tempStateDir();

  const coder = spawnBackground({
    stateDir,
    id: '2026-08-03-a-stored-ticket',
    role: 'coder',
    agentCmd: 'sleep 30',
    prompt: '',
  });
  spawnBackground({
    stateDir,
    id: '2026-08-03-a-stored-ticket',
    role: 'reviewer',
    agentCmd: 'true',
    prompt: '',
  });

  assert.equal(
    backgroundStatus({ stateDir, id: '2026-08-03-a-stored-ticket', role: 'coder' }).state,
    'running',
  );
  await waitFor(
    () =>
      backgroundStatus({ stateDir, id: '2026-08-03-a-stored-ticket', role: 'reviewer' }).state ===
      'finished',
  );
  // The coder run should not change when the reviewer finishes.
  assert.equal(
    backgroundStatus({ stateDir, id: '2026-08-03-a-stored-ticket', role: 'coder' }).state,
    'running',
  );

  process.kill(coder.pid!, 'SIGKILL');
});

// --------------------------------------------------------------------------- Tests for past bugs, so
// they do not come back. ---------------------------------------------------------------------------

// If a sandbox can't start, the command must not run unprotected.
// Level 4 needs a real sandbox, so a missing one must block the run.
function policyWithBackend(level: number, backend: string): Policy {
  const base = loadLevel(level);
  return { ...base, sandbox: { ...base.sandbox, backend } } as unknown as Policy;
}

test('a sandbox that could not start refuses to spawn at all', async () => {
  const stateDir = tempStateDir();
  const worktree = makeTempDir('wt');

  assert.throws(
    () =>
      spawnBackground({
        stateDir,
        id: '2026-08-05-a-sandbox-that-cannot-start',
        agentCmd: 'true',
        prompt: 'x',
        cwd: worktree,
        policy: policyWithBackend(4, 'podman'),
      }),
    /refusing to run the agent uncaged/,
  );

  // Nothing started, so no pid file was left behind to confuse later checks.
  assert.deepEqual(backgroundStatus({ stateDir, id: '2026-08-05-a-sandbox-that-cannot-start' }), {
    state: 'not-started',
  });
});

test('a level that asks for no sandbox still spawns normally', async () => {
  const stateDir = tempStateDir();
  const worktree = makeTempDir('wt');

  const { pid } = spawnBackground({
    stateDir,
    id: '2026-08-05-no-sandbox-still-spawns',
    agentCmd: 'true',
    prompt: 'x',
    cwd: worktree,
    policy: loadLevel(2),
  });
  assert.equal(typeof pid, 'number');
  await waitFor(
    () =>
      backgroundStatus({ stateDir, id: '2026-08-05-no-sandbox-still-spawns' }).state === 'finished',
  );
});

// Before this fix, spawning into a missing folder crashed the whole app
// instead of failing cleanly and telling the caller.
test('spawning into a directory that does not exist refuses up front', async () => {
  const stateDir = tempStateDir();
  const gone = path.join(os.tmpdir(), `glafka-not-here-${Date.now()}`);

  assert.throws(
    () =>
      spawnBackground({
        stateDir,
        id: '2026-08-05-spawn-into-a-missing-folder',
        agentCmd: 'true',
        prompt: 'x',
        cwd: gone,
      }),
    /does not exist/,
  );

  // No pid file, so nothing later mistakes this for a crashed run.
  assert.deepEqual(backgroundStatus({ stateDir, id: '2026-08-05-spawn-into-a-missing-folder' }), {
    state: 'not-started',
  });
});

test('a real spawn still records a real pid', async () => {
  const stateDir = tempStateDir();
  const worktree = makeTempDir('wt');
  const { pid } = spawnBackground({
    stateDir,
    id: '2026-08-05-a-real-spawn-records-a-pid',
    agentCmd: 'true',
    prompt: 'x',
    cwd: worktree,
  });
  assert.equal(typeof pid, 'number');
  assert.ok(pid! > 0);
  await waitFor(
    () =>
      backgroundStatus({ stateDir, id: '2026-08-05-a-real-spawn-records-a-pid' }).state ===
      'finished',
  );
});

// Before this fix, killing a run could kill an unrelated process.
// This happened if the old pid got reused by a new process.
test('killBackground refuses to signal a pid that is no longer our run', async () => {
  const stateDir = tempStateDir();
  const { pidPath, dir, logPath, exitCodePath } = runFiles(
    stateDir,
    '2026-08-05-kill-refuses-a-stale-pid',
    'coder',
  );
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(logPath, '');
  // Use a pid that is alive but not ours: this test's own process.
  fs.writeFileSync(pidPath, String(process.pid));
  // This run already has an exit code, so it is finished, not running.
  fs.writeFileSync(exitCodePath, '0');

  assert.equal(killBackground({ stateDir, id: '2026-08-05-kill-refuses-a-stale-pid' }), false);
});

// A coder killed by a signal never writes an exit code, so the ONLY thing that used
// to tell "our run" from "the OS gave this pid to someone else" was isAlive(pid) — true for both. spawnBackground now also records the OS's own start time for the pid it spawned, and killBackground — the one place a mismatch is actually dangerous, since it signals a whole process group — checks it before sending anything. backgroundStatus deliberately does NOT run this check: it is read-only, and it gets polled far more often than a run ever actually needs killing (every vima tick, every `--status`, every test's own waitFor loop). Shelling out to `ps` on each of those calls is real, measurable overhead for no safety gain — the label going stale for a moment costs nothing on its own, because nothing acts on "running" without going through killBackground's own re-check first.
test('killBackground refuses when the start-time proof no longer matches, even though the (recycled) pid is alive', async () => {
  const stateDir = tempStateDir();
  const { pid } = spawnBackground({
    stateDir,
    id: '2026-08-05-spawn-into-a-missing-folder',
    agentCmd: 'sleep 30',
    prompt: '',
  });
  await waitFor(
    () =>
      backgroundStatus({ stateDir, id: '2026-08-05-spawn-into-a-missing-folder' }).state ===
      'running',
  );

  const { startProofPath } = runFiles(stateDir, '2026-08-05-spawn-into-a-missing-folder', 'coder');
  assert.equal(fs.existsSync(startProofPath), true, 'spawnBackground records a start proof');

  // Simulate the OS handing this exact pid to a different, unrelated process a while after ours
  // actually started. backgroundStatus still calls it "running" (see above), but killBackground must refuse.
  fs.writeFileSync(startProofPath, String(Date.now() - 5 * 60 * 1000));

  assert.equal(
    backgroundStatus({ stateDir, id: '2026-08-05-spawn-into-a-missing-folder' }).state,
    'running',
  );
  assert.equal(killBackground({ stateDir, id: '2026-08-05-spawn-into-a-missing-folder' }), false);

  // The real process is still alive — proof this was the reuse check
  // catching it, not the process actually having died.
  assert.equal(isAlive(pid!), true);
  process.kill(pid!, 'SIGKILL');
});

test('an untampered start proof still reports running normally', async () => {
  const stateDir = tempStateDir();
  const { pid } = spawnBackground({
    stateDir,
    id: '2026-08-05-a-real-spawn-records-a-pid',
    agentCmd: 'sleep 30',
    prompt: '',
  });
  await waitFor(
    () =>
      backgroundStatus({ stateDir, id: '2026-08-05-a-real-spawn-records-a-pid' }).state ===
      'running',
  );

  assert.equal(
    backgroundStatus({ stateDir, id: '2026-08-05-a-real-spawn-records-a-pid' }).state,
    'running',
  );
  assert.equal(killBackground({ stateDir, id: '2026-08-05-a-real-spawn-records-a-pid' }), true);
  await waitFor(() => !isAlive(pid!));
});

test('killBackground still kills a run that really is running', async () => {
  const stateDir = tempStateDir();
  const worktree = makeTempDir('wt');
  const { pid } = spawnBackground({
    stateDir,
    id: '2026-08-05-kill-a-coder-that-is-running',
    agentCmd: 'sleep 30',
    prompt: 'x',
    cwd: worktree,
  });
  await waitFor(
    () =>
      backgroundStatus({ stateDir, id: '2026-08-05-kill-a-coder-that-is-running' }).state ===
      'running',
  );

  assert.equal(killBackground({ stateDir, id: '2026-08-05-kill-a-coder-that-is-running' }), true);
  await waitFor(() => !isAlive(pid!));
});

// The documented Claude-Code flow hands the prompt to a subagent this process never
// spawns and never sees the pid of, so backgroundStatus said "not-started" forever. That made `vima` spawn a second coder into the same worktree, and let `assertNoLiveRun` treat the ticket as though nobody was working on it.
test('markExternalRunStarted turns "not-started" into "running", with no pid on file', () => {
  const stateDir = tempStateDir();
  assert.equal(
    backgroundStatus({ stateDir, id: '2026-08-05-an-external-run-marked-started' }).state,
    'not-started',
  );

  markExternalRunStarted({ stateDir, id: '2026-08-05-an-external-run-marked-started' });

  const status = backgroundStatus({ stateDir, id: '2026-08-05-an-external-run-marked-started' });
  assert.equal(status.state, 'running');
  const { pidPath } = runFiles(stateDir, '2026-08-05-an-external-run-marked-started', 'coder');
  assert.equal(fs.existsSync(pidPath), false);
});

test('an externally-dispatched run times out the same way a real one does', () => {
  const stateDir = tempStateDir();
  markExternalRunStarted({ stateDir, id: '2026-08-05-an-external-run-marked-started' });

  assert.equal(
    backgroundStatus({
      stateDir,
      id: '2026-08-05-an-external-run-marked-started',
      maxRuntimeMs: -1,
    }).state,
    'timed-out',
  );
  // No pid was ever known, so there is nothing killBackground can signal —
  // but it must not throw or pretend it killed something.
  assert.equal(
    killBackground({ stateDir, id: '2026-08-05-an-external-run-marked-started' }),
    false,
  );
});

test('calling it again re-stamps the start time, acting as a heartbeat', async () => {
  const stateDir = tempStateDir();
  markExternalRunStarted({ stateDir, id: '2026-08-05-an-external-run-marked-started' });
  const { startedAtPath } = runFiles(
    stateDir,
    '2026-08-05-an-external-run-marked-started',
    'coder',
  );
  const first = fs.readFileSync(startedAtPath, 'utf8');

  await new Promise((resolve) => setTimeout(resolve, 5));
  markExternalRunStarted({ stateDir, id: '2026-08-05-an-external-run-marked-started' });
  const second = fs.readFileSync(startedAtPath, 'utf8');

  assert.notEqual(first, second);
  assert.equal(
    backgroundStatus({
      stateDir,
      id: '2026-08-05-an-external-run-marked-started',
      maxRuntimeMs: -1,
    }).state,
    'timed-out',
  );
});

test('a leftover finished/failed marker from a real run does not leak into a later external dispatch', () => {
  const stateDir = tempStateDir();
  const { pid } = spawnBackground({
    stateDir,
    id: '2026-08-05-an-external-run-marked-started',
    agentCmd: 'true',
    prompt: '',
  });
  return (
    waitFor(
      () =>
        backgroundStatus({ stateDir, id: '2026-08-05-an-external-run-marked-started' }).state ===
        'finished',
    )
      // The wrapper writes the exit code and only THEN exits, so "finished"
      // does not yet mean gone — under load that gap is wide enough to lose.
      .then(() => waitFor(() => !isAlive(pid!)))
      .then(() => {
        markExternalRunStarted({ stateDir, id: '2026-08-05-an-external-run-marked-started' });
        // Nothing is alive now, so a "running" here can only come from the
        // external-dispatch marker — which is the leak this test guards.
        assert.equal(
          backgroundStatus({ stateDir, id: '2026-08-05-an-external-run-marked-started' }).state,
          'running',
        );
      })
  );
});

// markExternalRunStarted writes a start marker and no pid, and nothing ever removes it
// — so backgroundStatus stays in a RUNNING state for good. assertNoLiveRun must not turn that into a permanent refusal, because the marker proves a prompt was handed out, not that anything is writing.
test('a run with no pid we can check warns instead of wedging the ticket', () => {
  const stateDir = makeTempDir('extrun');
  const id = '2026-08-07-add-search-filters';
  markExternalRunStarted({ stateDir, id });

  assert.equal(hasPidFile({ stateDir, id }), false, 'the external path writes no pid');
  assert.ok(
    RUNNING_STATES.has(backgroundStatus({ stateDir, id }).state),
    'and it reads as running, which is the state with no exit',
  );

  // The whole point: this must return, not throw.
  const status = assertNoLiveRun({
    stateDir,
    id,
    action: 'closing',
    risk: 'the worktree would be torn down',
  });
  assert.ok(RUNNING_STATES.has(status.state));

  // A run we DID spawn still blocks, which is the behaviour worth keeping.
  const { pidPath } = runFiles(stateDir, id, 'coder');
  fs.writeFileSync(pidPath, String(process.pid));
  assert.throws(
    () =>
      assertNoLiveRun({ stateDir, id, action: 'closing', risk: 'the worktree would be torn down' }),
    /still running/,
  );

  fs.rmSync(stateDir, { recursive: true, force: true });
});

// The ports and connection strings provisioning wrote into the worktree. The coder was told
// in its prompt that .env.glafka exists and left to read it by hand; a command it runs to try
// its own work out reached the project's normal hardcoded database, not this ticket's.
test('the agent runs with the ticket env from .env.glafka in its worktree', async () => {
  const stateDir = tempStateDir();
  const worktree = makeTempDir('bg-worktree');
  fs.writeFileSync(
    path.join(worktree, '.env.glafka'),
    'DATABASE_URL=postgresql://localhost:4137/app\n',
  );
  const id = '2026-08-03-a-stored-ticket';

  spawnBackground({
    stateDir,
    id,
    agentCmd: 'printf "saw %s" "$DATABASE_URL"',
    prompt: '',
    cwd: worktree,
  });

  const { logPath, exitCodePath } = runFiles(stateDir, id);
  await waitFor(() => fs.existsSync(exitCodePath));
  assert.match(fs.readFileSync(logPath, 'utf8'), /saw postgresql:\/\/localhost:4137\/app/);
});

// Isolation is the point of those ports. A value in the developer's own shell
// must not quietly replace the one this ticket holds.
test('the ticket env beats an ambient value of the same name', async () => {
  const stateDir = tempStateDir();
  const worktree = makeTempDir('bg-worktree-precedence');
  fs.writeFileSync(path.join(worktree, '.env.glafka'), 'DB_PORT=4137\n');
  const id = '2026-08-03-a-stored-ticket';
  process.env.DB_PORT = '5432';

  try {
    spawnBackground({
      stateDir,
      id,
      agentCmd: 'printf "port %s" "$DB_PORT"',
      prompt: '',
      cwd: worktree,
    });
    const { logPath, exitCodePath } = runFiles(stateDir, id);
    await waitFor(() => fs.existsSync(exitCodePath));
    assert.match(fs.readFileSync(logPath, 'utf8'), /port 4137/);
  } finally {
    delete process.env.DB_PORT;
  }
});

// The caged path builds its environment from scratch instead of inheriting one, so it needs
// the ticket's values handed to it explicitly. Guardrails is also where this matters most:
// the agent has no other way to reach its own database once the ambient env is stripped.
test('a caged agent gets the ticket env too', async () => {
  const stateDir = tempStateDir();
  const worktree = makeTempDir('bg-worktree-caged');
  fs.writeFileSync(
    path.join(worktree, '.env.glafka'),
    'DATABASE_URL=postgresql://localhost:4137/app\n',
  );
  const id = '2026-08-03-a-stored-ticket';
  // Secrets filtering on, no sandbox to start — this test is about the env, and a
  // missing sandbox backend would refuse the run for an unrelated reason.
  const base = loadLevel(1);
  const policy = { ...base, sandbox: { ...base.sandbox, enabled: false } } as unknown as Policy;

  spawnBackground({
    stateDir,
    id,
    agentCmd: 'printf "saw %s" "$DATABASE_URL"',
    prompt: '',
    cwd: worktree,
    policy,
  });

  const { logPath, exitCodePath } = runFiles(stateDir, id);
  await waitFor(() => fs.existsSync(exitCodePath));
  assert.match(fs.readFileSync(logPath, 'utf8'), /saw postgresql:\/\/localhost:4137\/app/);
});

// A tool call the agent makes is free to start its own process group — proven directly of Claude
// Code's own Bash tool: a reviewer's pid and its Bash call's pgid were two different numbers. The
// group signal `killBackground` used to send alone never reached a descendant like that, so a
// reviewer could be "killed" and still have a live process behind it.
test('killBackground reaches a descendant that put itself in its own process group', async () => {
  if (process.platform === 'win32') return;
  const stateDir = tempStateDir();
  const worktree = makeTempDir('wt');
  const marker = makeTempDir('marker');
  const pidFile = path.join(marker, 'child-pid');
  const id = '2026-08-09-regroup-kill';

  // `os.setsid()` then exec puts `sleep` in a NEW session and group — not the one spawnBackground
  // gave the wrapper. A file, not an inline one-liner, because the quoting to nest this inside
  // `sh -c '...'` inside the agentCmd string was unreadable and Python has no portable `setsid(1)`
  // binary to shell out to instead (Linux ships one, macOS does not).
  const regrouperPath = path.join(marker, 'regroup.py');
  fs.writeFileSync(
    regrouperPath,
    'import os, sys\nos.setsid()\nwith open(sys.argv[1], "w") as f:\n    f.write(str(os.getpid()))\nos.execvp("sleep", ["sleep", "60"])\n',
  );

  spawnBackground({
    stateDir,
    id,
    // Backgrounded so the wrapper shell can `wait` on it and stay "running" until signalled — the
    // regrouped process writes its OWN pid once it has actually left the wrapper's group.
    agentCmd: `sh -c 'python3 ${regrouperPath} ${pidFile} & wait'`,
    prompt: '',
    cwd: worktree,
  });

  await waitFor(() => fs.existsSync(pidFile));
  const childPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  await waitFor(() => backgroundStatus({ stateDir, id }).state === 'running');
  assert.equal(
    isAlive(childPid),
    true,
    'the re-grouped child must really be running before the kill',
  );

  assert.equal(killBackground({ stateDir, id }), true);
  await waitFor(() => !isAlive(childPid));
});

// The narrower, best-effort half: a run already marked "finished" (its own exit code is written,
// so nothing is waiting for it or its children any more) can still have a live process behind it —
// this is the "coder reports done, reviewer OS process keeps running" report. `reapOrphans` finds a
// survivor that kept the run's own process group, which is the ordinary case (no explicit setsid).
test('reapOrphans kills a process a finished run left running behind it', async () => {
  if (process.platform === 'win32') return;
  const stateDir = tempStateDir();
  const worktree = makeTempDir('wt');
  const pidFile = path.join(makeTempDir('marker'), 'child-pid');
  const id = '2026-08-09-reap-orphan';

  spawnBackground({
    stateDir,
    id,
    // Backgrounds a sleep in the SAME group (no setsid), then the wrapper exits immediately —
    // simulating an agent whose own top-level process is done while a tool call it made is not.
    agentCmd: `sh -c 'sleep 60 & echo $! > ${pidFile}; true'`,
    prompt: '',
    cwd: worktree,
  });

  await waitFor(() => fs.existsSync(pidFile));
  const childPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  await waitFor(() => backgroundStatus({ stateDir, id }).state === 'finished');
  assert.equal(
    isAlive(childPid),
    true,
    'the leftover child must really be alive once the run is "finished"',
  );

  const killed = reapOrphans({ stateDir, id, role: 'coder' });
  assert.ok(killed.includes(childPid));
  await waitFor(() => !isAlive(childPid));

  // Self-gating: a second call must not re-scan `ps` or try to kill an already-dead pid again.
  assert.deepEqual(reapOrphans({ stateDir, id, role: 'coder' }), []);
});
