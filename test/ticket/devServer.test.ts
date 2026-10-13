import { test } from 'node:test';
import assert from 'node:assert/strict';

import { IsolationProfileSchema } from '../../src/types/isolationProfile.js';
import { buildOdysseFullPrompt } from '../../src/commands/odysse/prompts.js';
import { runFiles } from '../../src/ticket/paths.js';

test('an isolation profile may name how the app is started', () => {
  const parsed = IsolationProfileSchema.parse({
    services: [{ name: 'web', envVars: ['PORT'] }],
    devCmd: 'pnpm dev',
    healthCmd: 'curl -sf localhost:$PORT/health',
  });

  assert.equal(parsed.devCmd, 'pnpm dev');
  assert.equal(parsed.healthCmd, 'curl -sf localhost:$PORT/health');
});

test('both are optional, so a project with nothing to run still parses', () => {
  const parsed = IsolationProfileSchema.parse({ setupCmd: 'docker run ...' });

  assert.equal(parsed.devCmd, undefined);
  assert.equal(parsed.healthCmd, undefined);
});

test('a non-string devCmd is refused with a named message', () => {
  const result = IsolationProfileSchema.safeParse({ devCmd: 42 });

  assert.equal(result.success, false);
  assert.match(JSON.stringify(result.error), /devCmd/);
});

test('the scan is told to discover how the app starts', () => {
  const prompt = buildOdysseFullPrompt({ repoRoot: '/repo', tree: 'src/' });

  assert.match(prompt, /"devCmd"/);
  assert.match(prompt, /"healthCmd"/);
  // The two mistakes that would make the field useless.
  assert.match(prompt, /Not one\s+command per service/);
  assert.match(prompt, /must stay in the foreground/);
});

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

import {
  startDevServer,
  waitForReady,
  devServerAlive,
  stopDevServer,
  stopDevServerAndWait,
  stopDevServerNow,
  hasLiveChild,
  STOP_GRACE_MS,
  readDevLogTail,
} from '../../src/ticket/devServer.js';
import { isAlive } from '../../src/ticket/background.js';

function tempStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'glafka-dev-'));
}

// Every live process whose command line carries this marker.
function pidsMatching(marker: string): number[] {
  const out = execFileSync('ps', ['-eo', 'pid,command'], { encoding: 'utf8' });
  return out
    .split('\n')
    .filter((line) => line.includes(marker))
    .map((line) => Number(line.trim().split(/\s+/)[0]))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

// A signal is not instant, so give it a moment before believing a leftover.
async function survivors(marker: string, timeoutMs: number): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  let found = pidsMatching(marker);
  while (found.length > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    found = pidsMatching(marker);
  }
  return found;
}

// Same reason: SIGTERM is delivered, not applied on the spot.
async function waitForGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  return !isAlive(pid);
}

// A real listener on a real port, so readiness is observed and not simulated.
const LISTENER = (port: number) =>
  `node -e "require('net').createServer().listen(${port}, () => console.log('up')); setInterval(()=>{}, 1000)"`;

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

// A plain connect, on purpose NOT waitForReady — that is the thing under test,
// so it cannot also be what decides the app came up.
function connectsTo(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (answer: boolean) => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(500);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function listensOn(port: number, host: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await connectsTo(port, host)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}

// Getting an app listening is plumbing, not what any of these tests is about.
// Two things can go wrong in it: the port is taken between picking it and
// binding it, and a loaded machine is slow to start node. Both are retried on
// a fresh port here, so the assertion that follows is about the code under
// test and nothing else. A real failure still fails, just after 3 tries.
async function startedAndListening({
  stateDir,
  id,
  cmd,
  host = '127.0.0.1',
  tries = 3,
}: {
  stateDir: string;
  id: string;
  cmd: (port: number) => string;
  host?: string;
  tries?: number;
}): Promise<{ port: number; pid: number }> {
  for (let attempt = 1; ; attempt++) {
    const port = await freePort();
    const { pid = 0 } = startDevServer({
      stateDir,
      id,
      cmd: cmd(port),
      cwd: process.cwd(),
      env: {},
    });
    if (await listensOn(port, host, 10_000)) return { port, pid };

    const log = readDevLogTail({ stateDir, id });
    await stopDevServerAndWait({ stateDir, id });
    if (attempt === tries) {
      assert.fail(
        `app never listened on ${host}:${port}, ${tries} tries. app log: ${log ?? '(empty)'}`,
      );
    }
  }
}

test('a started dev server is alive, and stopping it makes it not alive', async () => {
  const stateDir = tempStateDir();

  const { port, pid } = await startedAndListening({
    stateDir,
    id: '2026-08-07-a-doc-named-by-its-id',
    cmd: LISTENER,
  });
  assert.ok(pid > 0);

  assert.equal(await waitForReady({ ports: [port], cwd: process.cwd(), timeoutMs: 10_000 }), true);
  assert.equal(devServerAlive({ stateDir, id: '2026-08-07-a-doc-named-by-its-id' }), true);

  assert.equal(stopDevServer({ stateDir, id: '2026-08-07-a-doc-named-by-its-id' }), true);
  assert.equal(devServerAlive({ stateDir, id: '2026-08-07-a-doc-named-by-its-id' }), false);
  // devServerAlive is also false when only the pid file was removed. This is
  // the part that proves the process itself died.
  assert.equal(await waitForGone(pid, 5_000), true);
});

test('readiness gives up rather than waiting forever', async () => {
  const port = await freePort();

  const ready = await waitForReady({ ports: [port], cwd: process.cwd(), timeoutMs: 600 });

  // Nothing is listening on that port, so this must come back false, on time.
  assert.equal(ready, false);
});

test('a healthCmd is used in preference to the port probe', async () => {
  // The port is never bound, so only the healthCmd can make this ready.
  const port = await freePort();

  const ready = await waitForReady({
    ports: [port],
    healthCmd: 'exit 0',
    cwd: process.cwd(),
    timeoutMs: 5_000,
  });

  assert.equal(ready, true);
});

test('a failing healthCmd is not ready, whatever the ports say', async () => {
  const port = await freePort();
  const stateDir = tempStateDir();
  startDevServer({
    stateDir,
    id: '2026-08-06-a-health-check-that-fails',
    cmd: LISTENER(port),
    cwd: process.cwd(),
    env: {},
  });

  const ready = await waitForReady({
    ports: [port],
    healthCmd: 'exit 1',
    cwd: process.cwd(),
    timeoutMs: 800,
  });

  assert.equal(ready, false);
  stopDevServer({ stateDir, id: '2026-08-06-a-health-check-that-fails' });
});

test('the app output is captured, so a failure to start can be explained', async () => {
  const stateDir = tempStateDir();
  startDevServer({
    stateDir,
    id: '2026-08-06-the-app-output-is-captured',
    cmd: 'echo "listening on 4137"; echo "boom" >&2; sleep 5',
    cwd: process.cwd(),
    env: {},
  });
  await new Promise((r) => setTimeout(r, 400));

  const tail = readDevLogTail({ stateDir, id: '2026-08-06-the-app-output-is-captured', lines: 10 });

  assert.match(tail ?? '', /listening on 4137/);
  // stderr lands in the same log, or half the reason would be missing.
  assert.match(tail ?? '', /boom/);
  stopDevServer({ stateDir, id: '2026-08-06-the-app-output-is-captured' });
});

test('stopping a server that was never started is not an error', () => {
  const stateDir = tempStateDir();

  assert.equal(stopDevServer({ stateDir, id: '2026-08-06-stopping-what-never-started' }), false);
  assert.equal(devServerAlive({ stateDir, id: '2026-08-06-stopping-what-never-started' }), false);
});

test('waiting for a server that was never started costs nothing', async () => {
  const stateDir = tempStateDir();

  const startedAt = Date.now();
  assert.equal(
    await stopDevServerAndWait({ stateDir, id: '2026-08-06-waiting-for-nothing' }),
    true,
  );

  // Nothing to watch means nothing to wait for. Spending the grace here would
  // put it on every close of every project that runs no app.
  assert.ok(Date.now() - startedAt < STOP_GRACE_MS, 'it waited on an app that was never there');
});

test('a well-behaved app is waited for, and gone when the wait returns', async () => {
  const stateDir = tempStateDir();
  const { port, pid } = await startedAndListening({
    stateDir,
    id: '2026-08-06-a-well-behaved-app',
    cmd: LISTENER,
  });
  assert.equal(await waitForReady({ ports: [port], cwd: process.cwd(), timeoutMs: 10_000 }), true);

  const startedAt = Date.now();
  assert.equal(await stopDevServerAndWait({ stateDir, id: '2026-08-06-a-well-behaved-app' }), true);
  const elapsed = Date.now() - startedAt;

  // No polling afterwards: the wait is what makes this true on the spot.
  assert.equal(isAlive(pid), false);
  assert.ok(elapsed < STOP_GRACE_MS, `took ${elapsed}ms — a clean exit must not cost the grace`);
});

test('a pid the system handed to something else is not treated as ours', async () => {
  const stateDir = tempStateDir();
  const port = await freePort();
  startDevServer({
    stateDir,
    id: '2026-08-06-a-pid-handed-to-something-else',
    cmd: LISTENER(port),
    cwd: process.cwd(),
    env: {},
  });
  await waitForReady({ ports: [port], cwd: process.cwd(), timeoutMs: 10_000 });

  // Rewrite the proof so it can no longer match the running process.
  const proofPath = runFiles(
    stateDir,
    '2026-08-06-a-pid-handed-to-something-else',
    'dev',
  ).startProofPath;
  const realProof = fs.readFileSync(proofPath, 'utf8');
  fs.writeFileSync(proofPath, '1');

  assert.equal(
    devServerAlive({ stateDir, id: '2026-08-06-a-pid-handed-to-something-else' }),
    false,
  );

  // Put the real proof back, or the stop below refuses too and the process
  // outlives the suite.
  fs.writeFileSync(proofPath, realProof);
  // Clean up the process the test really did start.
  assert.equal(stopDevServer({ stateDir, id: '2026-08-06-a-pid-handed-to-something-else' }), true);
});

// The wrapper shell can die while everything it started keeps running. Asking only about that one
// pid answered "nothing to stop", so lysis deleted a worktree a live app then wrote files back into.
test('an app that outlived its wrapper shell is still found, and still stopped', async () => {
  const stateDir = tempStateDir();
  const id = '2026-08-11-an-app-that-outlived-its-shell';
  const marker = `glafka-orphan-app-${process.pid}-${Date.now()}`;
  // Backgrounded, then the shell exits: the recorded pid goes, the app stays,
  // and it keeps the process group the shell led.
  const { pid } = startDevServer({
    stateDir,
    id,
    cmd: `node -e "setInterval(()=>{},1000)" ${marker} & exit 0`,
    cwd: process.cwd(),
    env: {},
  });
  assert.ok(pid != null && pid > 0);
  assert.equal(await waitForGone(pid, 5_000), true, 'the wrapper shell was meant to die');
  assert.ok(pidsMatching(marker).length > 0, 'the app was meant to outlive the shell');

  assert.equal(devServerAlive({ stateDir, id }), true);

  assert.equal(await stopDevServerAndWait({ stateDir, id }), true);
  const leftovers = await survivors(marker, 5_000);
  // Kill before asserting, so a failure reports the leak instead of adding one.
  for (const stray of leftovers) {
    try {
      process.kill(stray, 'SIGKILL');
    } catch {
      // Already gone between listing and killing. Nothing to do.
    }
  }
  assert.deepEqual(leftovers, []);
});

test('a health command that hangs leaves nothing running behind it', async () => {
  const marker = `glafka-health-probe-${process.pid}-${Date.now()}`;
  // The shell starts a child and waits, so a kill aimed only at the shell
  // would leave that child alive.
  const hangs = `node -e "setInterval(()=>{},1000)" ${marker} & wait`;

  const ready = await waitForReady({ healthCmd: hangs, cwd: process.cwd(), timeoutMs: 100 });

  assert.equal(ready, false);
  const leftovers = await survivors(marker, 5_000);
  // Kill before asserting, so a failure reports the leak instead of adding one.
  for (const pid of leftovers) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone between listing and killing. Nothing to do.
    }
  }
  assert.deepEqual(leftovers, []);
});

// Can this host bind ::1 at all? A machine with IPv6 switched off has nothing
// for the test below to observe.
async function ipv6Loopback(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen({ port: 0, host: '::1' }, () => probe.close(() => resolve(true)));
  });
}

test('an app that binds IPv6 only still reads as ready', async (t) => {
  if (!(await ipv6Loopback())) return t.skip('this host has no IPv6 loopback');
  const stateDir = tempStateDir();
  // Confirmed up on ::1 before we ask waitForReady anything, so a false below
  // means it did not look at ::1 — which is the whole point of this test.
  const { port } = await startedAndListening({
    stateDir,
    id: '2026-08-06-an-app-that-binds-ipv6-only',
    // ::1 only. A probe that knows just 127.0.0.1 never connects to this.
    cmd: (p) =>
      `node -e "require('net').createServer().listen(${p}, '::1'); setInterval(()=>{},1000)"`,
    host: '::1',
  });

  const ready = await waitForReady({ ports: [port], cwd: process.cwd(), timeoutMs: 10_000 });

  assert.equal(ready, true, `the app is up on ::1:${port}, but waitForReady did not see it`);
  await stopDevServerAndWait({ stateDir, id: '2026-08-06-an-app-that-binds-ipv6-only' });
});

// The signal path cannot await, so it escalates blind. SIGTERM alone left an
// app that ignores it running, detached, on ports the ticket was giving back.
test('the signal-path stop also ends an app that ignores SIGTERM', async () => {
  const stateDir = tempStateDir();
  const marker = `glafka-deaf-app-${process.pid}-${Date.now()}`;
  const { port, pid } = await startedAndListening({
    stateDir,
    id: '2026-08-06-an-app-that-ignores-sigterm',
    cmd: (p) =>
      `node -e "process.on('SIGTERM',()=>{}); require('net').createServer().listen(${p}); ` +
      `setInterval(()=>{},1000)" ${marker}`,
  });
  assert.equal(await waitForReady({ ports: [port], cwd: process.cwd(), timeoutMs: 10_000 }), true);

  const startedAt = Date.now();
  const stopped = stopDevServerNow({ stateDir, id: '2026-08-06-an-app-that-ignores-sigterm' });
  const elapsed = Date.now() - startedAt;

  assert.equal(stopped, true);
  // Bounded, because a person pressing Ctrl-C is asking for this to stop.
  assert.ok(elapsed < STOP_GRACE_MS, `took ${elapsed}ms — a signal handler must not sit that long`);
  // It cannot be watched from inside the handler, so it is watched from here.
  assert.equal(await waitForGone(pid, 5_000), true);
  assert.deepEqual(await survivors(marker, 5_000), []);
});

test('the signal-path stop says so, and costs nothing, when nothing was started', () => {
  const stateDir = tempStateDir();

  const startedAt = Date.now();
  assert.equal(
    stopDevServerNow({ stateDir, id: '2026-08-06-a-signal-stop-with-nothing-running' }),
    false,
  );

  assert.ok(Date.now() - startedAt < STOP_GRACE_MS, 'it waited on an app that was never there');
});

// Windows has no process group, so a killed leader's tree is found through the
// parent link its children keep. This is the only decision in that lookup.
test('a child left behind by a killed leader still counts as the tree being alive', () => {
  // 100 is under 42, which is the leader `taskkill` claimed to have taken.
  const parents = new Map([
    [100, 42],
    [200, 100],
    [300, 7],
  ]);

  assert.equal(hasLiveChild(parents, 42), true);
  assert.equal(hasLiveChild(parents, 100), true);
  assert.equal(hasLiveChild(parents, 7), true);
  // Nothing is under these two, so there is no tree left below them.
  assert.equal(hasLiveChild(parents, 200), false);
  assert.equal(hasLiveChild(parents, 999), false);
});

test('nothing is under anything when the machine reported no processes', () => {
  assert.equal(hasLiveChild(new Map(), 42), false);
});
