import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { makeGitRepo } from '../helpers/gitFixture.js';
import { makeTempDir } from '../helpers/tempDir.js';
import { createTicket, attachSpec, attachPlan } from '../../src/commands/genesis/genesis.js';
import { ergon, buildErgonPrompt } from '../../src/commands/ergon/ergon.js';
import { runVima } from '../../installKit/bin/commands/vima.js';
import { poreia, renderPoreia } from '../../src/commands/poreia/poreia.js';
import { vima, TICK_READY_TIMEOUT_MS } from '../../src/commands/vima/vima.js';
import { cancel } from '../../src/commands/cancel/cancel.js';
import { lysis, findOrphans, purgeOrphan } from '../../src/commands/lysis/lysis.js';
import { logos } from '../../src/commands/logos/logos.js';
import { ensureDevServer, reportDevServer } from '../../src/ticket/resources.js';
import {
  DEV_ROLE,
  DEFAULT_READY_TIMEOUT_MS,
  STOP_GRACE_MS,
  KILL_GRACE_MS,
  devServerAlive,
  stopDevServer,
} from '../../src/ticket/devServer.js';
import { readTicket } from '../../src/ticket/ticketStore.js';
import { runFiles, ticketFiles, ticketsDir, planPath } from '../../src/ticket/paths.js';
import { isAlive } from '../../src/ticket/background.js';
import { withFileLockAsync } from '../../src/util/fileOperations.js';
import { execFileSync } from 'node:child_process';
import { runErgon } from '../../installKit/bin/commands/ergon.js';
import { killBackground, backgroundStatus } from '../../src/ticket/background.js';
import type { Config } from '../../src/types/config.js';
import { withoutAgentCmd } from '../helpers/noAgentEnv.js';

// These tests need no agent configured. Cleared here, so running this file directly is safe too.
withoutAgentCmd();

// Writes an isolation profile whose app is a real, long-lived listener on the
// port glafka reserved for it.
function withDevCmd(repoRoot: string, extra: Record<string, unknown> = {}): void {
  const dir = path.join(repoRoot, 'docs', 'glafka', 'architecture');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'isolation.json'),
    JSON.stringify({
      services: [{ name: 'web', envVars: ['PORT'] }],
      devCmd:
        'node -e "require(\'net\').createServer().listen(process.env.PORT); setInterval(()=>{},1000)"',
      ...extra,
    }),
  );
}

function writeFile(content: string): string {
  const file = path.join(makeTempDir('doc'), 'doc.md');
  fs.writeFileSync(file, content);
  return file;
}

// One idea per call: two tickets on the same idea would be refused, and the
// --all tests provision more than one.
let thing = 0;
async function provisioned(repoRoot: string, stateDir: string) {
  const created = createTicket({ stateDir, repoRoot, content: `add a thing ${++thing}` });
  attachSpec({ stateDir, repoRoot, id: created.id, specPath: writeFile('spec'), title: 'A thing' });
  return attachPlan({
    stateDir,
    repoRoot,
    id: created.id,
    planPath: writeFile('## Task 1: do it\n\n- [ ] **Step 1: go**\n'),
  });
}

// Every dev-server line goes to stderr, so a test that reads the message has to
// hold on to console.error while the work runs.
async function captureStderr<T>(fn: () => T | Promise<T>): Promise<{ said: string; value: T }> {
  const notes: string[] = [];
  const realError = console.error;
  console.error = (msg: string) => notes.push(String(msg));
  try {
    return { value: await fn(), said: notes.join('\n') };
  } finally {
    console.error = realError;
  }
}

async function gone(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  return !isAlive(pid);
}

async function until(predicate: () => boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

// An app that never listens, so readiness can only ever run out of time. The
// shell marks the start, which is instant — a node still booting is not.
function neverReady(startLog: string, { deafToSigterm = false } = {}): string {
  const deaf = deafToSigterm ? "process.on('SIGTERM',()=>{}); " : '';
  return `echo started >> ${startLog}; node -e "${deaf}setInterval(()=>{},1000)"`;
}

function startCount(startLog: string): number {
  if (!fs.existsSync(startLog)) return 0;
  return fs.readFileSync(startLog, 'utf8').split('\n').filter(Boolean).length;
}

// The app's whole process group, which is what a stop has to empty. The wrapper
// shell goes on SIGTERM; an app that ignores it keeps the group alive.
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// SIGTERM is sent, not waited on, so the port stays bound for a moment after
// the stop returns. Starting again on it right away would race that.
async function stopAndWait(stateDir: string, id: string): Promise<void> {
  const { pidPath } = runFiles(stateDir, id, DEV_ROLE);
  const pid = fs.existsSync(pidPath) ? Number(fs.readFileSync(pidPath, 'utf8')) : null;
  stopDevServer({ stateDir, id });
  if (pid != null) await gone(pid);
}

test('provisioning starts the app on the port it reserved', async (t) => {
  const repoRoot = makeGitRepo();
  const stateDir = path.join(repoRoot, '.glafka');
  withDevCmd(repoRoot);

  const ticket = await provisioned(repoRoot, stateDir);
  t.after(() => stopDevServer({ stateDir, id: ticket.id }));

  assert.equal(devServerAlive({ stateDir, id: ticket.id }), true);
});

test('a project with no devCmd provisions exactly as it always did', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = path.join(repoRoot, '.glafka');

  const ticket = await provisioned(repoRoot, stateDir);

  assert.equal(devServerAlive({ stateDir, id: ticket.id }), false);
  assert.equal(fs.existsSync(ticket.worktree!), true);
});

test('an app that never comes up warns and leaves the ticket provisioned', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = path.join(repoRoot, '.glafka');
  const dir = path.join(repoRoot, 'docs', 'glafka', 'architecture');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'isolation.json'),
    JSON.stringify({
      services: [{ name: 'web', envVars: ['PORT'] }],
      // Prints, then exits without ever listening.
      devCmd: 'echo "cannot reach the database" >&2; exit 1',
    }),
  );

  const { said, value: ticket } = await captureStderr(() => provisioned(repoRoot, stateDir));

  // The ticket survives. That is the whole point.
  assert.equal(fs.existsSync(ticket.worktree!), true);
  assert.equal(readTicket(stateDir, ticket.id).branch !== null, true);

  assert.match(said, /not ready/);
  assert.match(said, /cannot reach the database/);
  assert.match(said, /--restart/);
});

test('ensureDevServer starts nothing when the app is already running', async (t) => {
  const repoRoot = makeGitRepo();
  const stateDir = path.join(repoRoot, '.glafka');
  withDevCmd(repoRoot);
  const ticket = await provisioned(repoRoot, stateDir);
  t.after(() => stopDevServer({ stateDir, id: ticket.id }));

  const outcome = await ensureDevServer({ stateDir, repoRoot, ticket });

  assert.equal(outcome, 'already-running');
});

test('ensureDevServer restarts an app whose process is gone', async (t) => {
  const repoRoot = makeGitRepo();
  const stateDir = path.join(repoRoot, '.glafka');
  withDevCmd(repoRoot);
  const ticket = await provisioned(repoRoot, stateDir);
  t.after(() => stopDevServer({ stateDir, id: ticket.id }));
  await stopAndWait(stateDir, ticket.id);

  const outcome = await ensureDevServer({ stateDir, repoRoot, ticket });

  assert.equal(outcome, 'started');
  assert.equal(devServerAlive({ stateDir, id: ticket.id }), true);
});

test('the app is started with what setupCmd printed, not only the ports', async (t) => {
  const repoRoot = makeGitRepo();
  const stateDir = path.join(repoRoot, '.glafka');
  // setupCmd hands back a value built from the reserved port, and the app
  // refuses to listen without it. A live app is proof the value reached it.
  withDevCmd(repoRoot, {
    setupCmd: 'echo GLAFKA_TEST_DSN=postgres://127.0.0.1:$PORT/app',
    devCmd:
      'node -e "if(!process.env.GLAFKA_TEST_DSN) process.exit(1);' +
      " require('net').createServer().listen(process.env.PORT); setInterval(()=>{},1000)\"",
  });

  const ticket = await provisioned(repoRoot, stateDir);
  t.after(() => stopDevServer({ stateDir, id: ticket.id }));

  const envFile = fs.readFileSync(path.join(ticket.worktree!, '.env.glafka'), 'utf8');
  assert.match(envFile, /GLAFKA_TEST_DSN=postgres:\/\/127\.0\.0\.1:\d+\/app/);
  assert.equal(devServerAlive({ stateDir, id: ticket.id }), true);
});

test('an app still starts when the worktree has no .env.glafka', async (t) => {
  const repoRoot = makeGitRepo();
  const stateDir = path.join(repoRoot, '.glafka');
  withDevCmd(repoRoot);
  const ticket = await provisioned(repoRoot, stateDir);
  t.after(() => stopDevServer({ stateDir, id: ticket.id }));
  await stopAndWait(stateDir, ticket.id);
  // A project may have none at all. Reading it is never a condition of a start.
  fs.rmSync(path.join(ticket.worktree!, '.env.glafka'));

  assert.equal(await ensureDevServer({ stateDir, repoRoot, ticket }), 'started');
});

test('nothing is spawned while another caller holds the spawn lock', async (t) => {
  const repoRoot = makeGitRepo();
  const stateDir = path.join(repoRoot, '.glafka');
  withDevCmd(repoRoot);
  const ticket = await provisioned(repoRoot, stateDir);
  t.after(() => stopDevServer({ stateDir, id: ticket.id }));
  await stopAndWait(stateDir, ticket.id);

  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Stands in for a second caller mid-spawn. The lock is taken before this
  // line returns, so nothing may start until release() below.
  const holding = withFileLockAsync(runFiles(stateDir, ticket.id, DEV_ROLE).lockPath, () => held);

  const started = ensureDevServer({ stateDir, repoRoot, ticket });
  await new Promise((resolve) => setTimeout(resolve, 200));
  // Unlocked, the check and the spawn run before the first await, so this
  // would already be true.
  const spawnedWhileHeld = devServerAlive({ stateDir, id: ticket.id });
  release();
  await holding;

  assert.equal(spawnedWhileHeld, false, 'an app was started while the spawn lock was held');
  assert.equal(await started, 'started');
  assert.equal(devServerAlive({ stateDir, id: ticket.id }), true);
});

test('ensureDevServer says so plainly when there is no app to run', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = path.join(repoRoot, '.glafka');
  const ticket = await provisioned(repoRoot, stateDir);

  assert.equal(await ensureDevServer({ stateDir, repoRoot, ticket }), 'no-dev-cmd');
});

test('a rollback after the app started leaves no process behind', async (t) => {
  const repoRoot = makeGitRepo();
  const stateDir = path.join(repoRoot, '.glafka');
  // The app records its own pid, so this can watch the real process rather
  // than the pid file, which the rollback removes either way.
  const pidFile = path.join(makeTempDir('devpid'), 'pid');
  withDevCmd(repoRoot, {
    devCmd:
      `node -e "require('fs').writeFileSync('${pidFile}', String(process.pid)); ` +
      `require('net').createServer().listen(process.env.PORT); setInterval(()=>{},1000)"`,
  });

  const created = createTicket({ stateDir, repoRoot, content: 'add a thing' });
  attachSpec({ stateDir, repoRoot, id: created.id, specPath: writeFile('spec'), title: 'A thing' });
  // A folder where plan.md has to go, so writing the plan throws once
  // provisioning is done and the app is already up.
  fs.mkdirSync(planPath(repoRoot, created.id), { recursive: true });
  t.after(() => stopDevServer({ stateDir, id: created.id }));

  await captureStderr(() =>
    assert.rejects(() =>
      attachPlan({
        stateDir,
        repoRoot,
        id: created.id,
        planPath: writeFile('## Task 1: do it\n\n- [ ] **Step 1: go**\n'),
      }),
    ),
  );

  assert.equal(
    fs.existsSync(pidFile),
    true,
    'the app must have started for this to prove anything',
  );
  assert.equal(await gone(Number(fs.readFileSync(pidFile, 'utf8'))), true);
  assert.equal(devServerAlive({ stateDir, id: created.id }), false);
});

test('a worktree that is gone is said plainly, not blamed on an older run', async (t) => {
  const repoRoot = makeGitRepo();
  const stateDir = path.join(repoRoot, '.glafka');
  withDevCmd(repoRoot);
  const ticket = await provisioned(repoRoot, stateDir);
  t.after(() => stopDevServer({ stateDir, id: ticket.id }));

  await stopAndWait(stateDir, ticket.id);
  fs.rmSync(ticket.worktree!, { recursive: true, force: true });
  // What the run that has just ended printed. Nothing to do with this one.
  fs.writeFileSync(runFiles(stateDir, ticket.id, DEV_ROLE).logPath, 'cannot reach the database\n');

  const outcome = await ensureDevServer({ stateDir, repoRoot, ticket });
  const { said } = await captureStderr(() =>
    reportDevServer(outcome, { stateDir, id: ticket.id, ports: [] }),
  );

  assert.equal(outcome, 'no-worktree');
  assert.match(said, /worktree/);
  assert.doesNotMatch(said, /cannot reach the database/);
});

// A tick with no coder configured stops at "nothing to spawn", which is all
// these need: the app is ensured before any of that is decided.
function tickConfig() {
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
  };
}

test('a tick brings a dead app back, and says what it had to do', async (t) => {
  const repoRoot = makeGitRepo();
  const stateDir = path.join(repoRoot, '.glafka');
  withDevCmd(repoRoot);
  const ticket = await provisioned(repoRoot, stateDir);
  t.after(() => stopDevServer({ stateDir, id: ticket.id }));
  await stopAndWait(stateDir, ticket.id);

  const restarted = await vima({ stateDir, id: ticket.id, repoRoot, config: tickConfig() });

  assert.equal(restarted.dev, 'started');
  assert.equal(devServerAlive({ stateDir, id: ticket.id }), true);

  // The next tick must report what it really found, not repeat itself.
  const again = await vima({ stateDir, id: ticket.id, repoRoot, config: tickConfig() });
  assert.equal(again.dev, 'already-running');
});

test('a tick on a project with no app is the tick it always was', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = path.join(repoRoot, '.glafka');
  const ticket = await provisioned(repoRoot, stateDir);

  const result = await vima({ stateDir, id: ticket.id, repoRoot, config: tickConfig() });

  // Not "dev is absent" — no field at all beyond the three it always returned.
  assert.deepEqual(Object.keys(result).sort(), ['action', 'id', 'reason']);
  assert.equal(devServerAlive({ stateDir, id: ticket.id }), false);
});

// A tick sweeps every open ticket one after another, so an app that hangs must
// not cost a tick the full provisioning wait.
test('a tick gives up on an app that will not come up long before provisioning would', async (t) => {
  const repoRoot = makeGitRepo();
  const stateDir = path.join(repoRoot, '.glafka');
  // Provisioned with a working app, so only the tick below pays a wait.
  withDevCmd(repoRoot);
  const ticket = await provisioned(repoRoot, stateDir);
  t.after(() => stopDevServer({ stateDir, id: ticket.id }));
  await stopAndWait(stateDir, ticket.id);
  // Now it stays alive and never listens, so readiness can only end on time.
  withDevCmd(repoRoot, { devCmd: 'node -e "setInterval(()=>{},1000)"' });

  const startedAt = Date.now();
  const result = await captureStderr(() =>
    vima({ stateDir, id: ticket.id, repoRoot, config: tickConfig() }),
  );
  const elapsed = Date.now() - startedAt;

  assert.equal(result.value.dev, 'not-ready');
  assert.ok(
    TICK_READY_TIMEOUT_MS < DEFAULT_READY_TIMEOUT_MS / 2,
    'the tick wait must be far shorter',
  );
  assert.ok(
    elapsed < DEFAULT_READY_TIMEOUT_MS / 2,
    `waited ${elapsed}ms — the tick used the full timeout`,
  );
  // A failed start leaves nothing holding the ports.
  assert.equal(devServerAlive({ stateDir, id: ticket.id }), false);
});

test('starting a coder brings the app back if it died', async (t) => {
  const repoRoot = makeGitRepo();
  const stateDir = path.join(repoRoot, '.glafka');
  withDevCmd(repoRoot);
  const ticket = await provisioned(repoRoot, stateDir);
  t.after(() => stopDevServer({ stateDir, id: ticket.id }));
  await stopAndWait(stateDir, ticket.id);
  assert.equal(devServerAlive({ stateDir, id: ticket.id }), false);

  await ergon({ stateDir, id: ticket.id, repoRoot });

  assert.equal(devServerAlive({ stateDir, id: ticket.id }), true);
});

test('looking at a ticket reports the app but never starts it', async (t) => {
  const repoRoot = makeGitRepo();
  const stateDir = path.join(repoRoot, '.glafka');
  withDevCmd(repoRoot);
  const ticket = await provisioned(repoRoot, stateDir);
  t.after(() => stopDevServer({ stateDir, id: ticket.id }));

  assert.equal(poreia({ stateDir, id: ticket.id, repoRoot }).devRunning, true);

  await stopAndWait(stateDir, ticket.id);
  assert.equal(poreia({ stateDir, id: ticket.id, repoRoot }).devRunning, false);
  // Looking twice must still not have started it.
  assert.equal(devServerAlive({ stateDir, id: ticket.id }), false);
});

test('the ticket dashboard shows whether the app is running', () => {
  // coder and steps are what every renderPoreia caller has to supply; the
  // three devRunning values are what this test is really about.
  const base = {
    id: '2026-08-07-add-dark-mode',
    title: 'A thing',
    specWritten: true,
    coder: { state: 'not-started' },
    steps: [],
  };
  const up = renderPoreia({ ...base, devRunning: true });
  const down = renderPoreia({ ...base, devRunning: false });
  const none = renderPoreia({ ...base, devRunning: null });

  assert.match(up, /app running/);
  assert.match(down, /app not running/);
  // A project with nothing to run must not grow a line saying so.
  assert.doesNotMatch(none, /app /);
});

// An app that writes down its own pid. Closing deletes glafka's pid file
// anyway, so only the process itself shows whether it really stopped.
function recordsItsPid(pidFile: string): string {
  return (
    `node -e "require('fs').writeFileSync('${pidFile}', String(process.pid)); ` +
    `require('net').createServer().listen(process.env.PORT); setInterval(()=>{},1000)"`
  );
}

test('cancelling a ticket stops its app', async (t) => {
  const repoRoot = makeGitRepo();
  const stateDir = path.join(repoRoot, '.glafka');
  const pidFile = path.join(makeTempDir('devpid'), 'pid');
  withDevCmd(repoRoot, { devCmd: recordsItsPid(pidFile) });
  const ticket = await provisioned(repoRoot, stateDir);
  t.after(() => stopDevServer({ stateDir, id: ticket.id }));
  assert.equal(devServerAlive({ stateDir, id: ticket.id }), true);

  await cancel({ stateDir, repoRoot, id: ticket.id });

  assert.equal(await gone(Number(fs.readFileSync(pidFile, 'utf8'))), true);
});

test('closing a ticket stops its app', async (t) => {
  const repoRoot = makeGitRepo();
  const stateDir = path.join(repoRoot, '.glafka');
  const pidFile = path.join(makeTempDir('devpid'), 'pid');
  withDevCmd(repoRoot, { devCmd: recordsItsPid(pidFile) });
  const ticket = await provisioned(repoRoot, stateDir);
  t.after(() => stopDevServer({ stateDir, id: ticket.id }));
  assert.equal(devServerAlive({ stateDir, id: ticket.id }), true);

  await lysis({ stateDir, repoRoot, id: ticket.id });

  assert.equal(await gone(Number(fs.readFileSync(pidFile, 'utf8'))), true);
});

test('a project with no app cancels exactly as it always did', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = path.join(repoRoot, '.glafka');
  const ticket = await provisioned(repoRoot, stateDir);

  const cancelled = await cancel({ stateDir, repoRoot, id: ticket.id });

  assert.equal(cancelled.id, ticket.id);
  assert.equal(fs.existsSync(ticket.worktree!), false);
});

test('the app is stopped before teardownCmd runs, not after', async (t) => {
  const repoRoot = makeGitRepo();
  const stateDir = path.join(repoRoot, '.glafka');
  withDevCmd(repoRoot);
  const ticket = await provisioned(repoRoot, stateDir);
  t.after(() => stopDevServer({ stateDir, id: ticket.id }));
  // Without this the app never starting would leave no pid file, and the
  // marker below would read "stopped" with the order untested.
  assert.equal(devServerAlive({ stateDir, id: ticket.id }), true);

  // Stopping the app is the only thing that removes this file, so teardown
  // writing down what it found is a real reading of the order.
  const { pidPath } = runFiles(stateDir, ticket.id, DEV_ROLE);
  const marker = path.join(repoRoot, 'teardown-saw');
  withDevCmd(repoRoot, {
    teardownCmd: `[ -e "${pidPath}" ] && echo running > "${marker}" || echo stopped > "${marker}"`,
  });

  await cancel({ stateDir, repoRoot, id: ticket.id });

  // An app still holding a database connection can hang container removal,
  // so the order is the point of this test.
  assert.equal(fs.existsSync(marker), true, 'teardownCmd must have run at all');
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'stopped');
});

test('an app deaf to the stop signal is killed, and the close still finishes', async (t) => {
  const repoRoot = makeGitRepo();
  const stateDir = path.join(repoRoot, '.glafka');
  const pidFile = path.join(makeTempDir('devpid'), 'pid');
  // It sits through SIGTERM, so only the wait and the SIGKILL after it can
  // end this one. The wrapper shell dies at once; the app is what survives.
  withDevCmd(repoRoot, {
    devCmd:
      `node -e "process.on('SIGTERM',()=>{}); require('fs').writeFileSync('${pidFile}', String(process.pid)); ` +
      `require('net').createServer().listen(process.env.PORT); setInterval(()=>{},1000)"`,
  });
  const ticket = await provisioned(repoRoot, stateDir);
  t.after(() => stopDevServer({ stateDir, id: ticket.id }));
  assert.equal(devServerAlive({ stateDir, id: ticket.id }), true);
  const appPid = Number(fs.readFileSync(pidFile, 'utf8'));

  const startedAt = Date.now();
  await cancel({ stateDir, repoRoot, id: ticket.id });
  const elapsed = Date.now() - startedAt;

  // Dead by the time cancel returned, not merely signalled and left.
  assert.equal(isAlive(appPid), false, `pid ${appPid} outlived the close`);
  assert.ok(elapsed >= STOP_GRACE_MS, `took ${elapsed}ms — the SIGTERM grace was never spent`);
  // Bounded: a close is never blocked by the app, however badly it behaves.
  assert.ok(
    elapsed < STOP_GRACE_MS + KILL_GRACE_MS + 5_000,
    `took ${elapsed}ms — over the stop budget`,
  );
});

test('the coder is told the app is running and where', () => {
  const prompt = buildErgonPrompt({
    ticket: {
      id: '2026-08-07-add-dark-mode',
      worktree: '/w',
      isolationPorts: { web: 4137, db: 5434 },
    },
    planContent: 'x',
    devRunning: true,
  });

  assert.match(prompt, /## The app is running/);
  assert.match(prompt, /4137/);
  assert.match(prompt, /glafka vima 2026-08-07-add-dark-mode --restart/);
});

test('a project with no app gains no section about one', () => {
  const prompt = buildErgonPrompt({
    ticket: { id: '2026-08-07-add-dark-mode' },
    planContent: 'x',
  });

  assert.doesNotMatch(prompt, /## The app is running/);
});

// The test above proves the builder. This proves the wiring: nothing tells the
// builder the app is up unless a real ticket really has one.
test('a real coder prompt says the app is up, and only when there is one', async (t) => {
  const withApp = makeGitRepo();
  const withAppState = path.join(withApp, '.glafka');
  withDevCmd(withApp);
  const running = await provisioned(withApp, withAppState);
  t.after(() => stopDevServer({ stateDir: withAppState, id: running.id }));

  const noApp = makeGitRepo();
  const noAppState = path.join(noApp, '.glafka');
  const quiet = await provisioned(noApp, noAppState);

  const up = await ergon({ stateDir: withAppState, id: running.id, repoRoot: withApp });
  const silent = await ergon({ stateDir: noAppState, id: quiet.id, repoRoot: noApp });

  assert.match(up.prompt, /## The app is running/);
  assert.match(up.prompt, new RegExp(`vima ${running.id} --restart`));
  assert.doesNotMatch(silent.prompt, /## The app is running/);
});

test('--restart is a flag vima really takes, and it brings the app back', async (t) => {
  const repoRoot = makeGitRepo();
  const stateDir = path.join(repoRoot, '.glafka');
  withDevCmd(repoRoot);
  const ticket = await provisioned(repoRoot, stateDir);
  t.after(() => stopDevServer({ stateDir, id: ticket.id }));

  const { pidPath } = runFiles(stateDir, ticket.id, DEV_ROLE);
  const before = Number(fs.readFileSync(pidPath, 'utf8'));

  const { said } = await captureStderr(() =>
    runVima({ args: [ticket.id, '--restart'], stateDir, repoRoot, config: tickConfig() }),
  );

  assert.equal(devServerAlive({ stateDir, id: ticket.id }), true);
  // A new process, and the old one really gone — not a no-op on the live one.
  assert.notEqual(Number(fs.readFileSync(pidPath, 'utf8')), before);
  assert.equal(await gone(before), true);
  // Not /ready/: "⚠ not ready" holds that word too, so the loose form passed
  // on the very failure this line is here to catch.
  assert.match(said, /dev\s+ready/);
});

test('--restart on an app that will not come up warns, and never throws', async (t) => {
  const repoRoot = makeGitRepo();
  const stateDir = path.join(repoRoot, '.glafka');
  withDevCmd(repoRoot);
  const ticket = await provisioned(repoRoot, stateDir);
  t.after(() => stopDevServer({ stateDir, id: ticket.id }));
  // From here the app prints and exits, so the restart below can only fail.
  withDevCmd(repoRoot, { devCmd: 'echo "cannot reach the database" >&2; exit 1' });

  const { said } = await captureStderr(() =>
    runVima({ args: [ticket.id, '--restart'], stateDir, repoRoot, config: tickConfig() }),
  );

  assert.match(said, /not ready/);
  assert.match(said, /cannot reach the database/);
  // A failed restart leaves nothing holding the ports.
  assert.equal(devServerAlive({ stateDir, id: ticket.id }), false);
});

test('--restart says so plainly when the project has nothing to run', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = path.join(repoRoot, '.glafka');
  const ticket = await provisioned(repoRoot, stateDir);

  const notes: string[] = [];
  const realLog = console.log;
  console.log = (msg: string) => notes.push(String(msg));
  try {
    await runVima({ args: [ticket.id, '--restart'], stateDir, repoRoot, config: tickConfig() });
  } finally {
    console.log = realLog;
  }

  assert.match(notes.join('\n'), /nothing to restart/);
  assert.equal(devServerAlive({ stateDir, id: ticket.id }), false);
});

test('--restart with no ticket id says how to use it, and changes nothing', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = path.join(repoRoot, '.glafka');

  // The id is now worked out rather than demanded, so with nothing open the
  // resolver's own error is what says how to use it. `glafka create` is only in
  // that message, never in the flag list, so this cannot pass just because the
  // flag itself was rejected.
  await assert.rejects(
    () => runVima({ args: ['--restart'], stateDir, repoRoot, config: tickConfig() }),
    /no open tickets — start one with: glafka create/,
  );
});

test('--restart with no ticket id uses the only open ticket', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = path.join(repoRoot, '.glafka');
  const ticket = await provisioned(repoRoot, stateDir);

  const notes: string[] = [];
  const realLog = console.log;
  console.log = (msg: string) => notes.push(String(msg));
  try {
    await runVima({ args: ['--restart'], stateDir, repoRoot, config: tickConfig() });
  } finally {
    console.log = realLog;
  }

  // This project has no devCmd, so naming the ticket is the whole proof.
  assert.match(notes.join('\n'), new RegExp(`${ticket.id}\\s+nothing to restart`));
});

test('--all --restart brings every open ticket’s app back', async (t) => {
  const repoRoot = makeGitRepo();
  const stateDir = path.join(repoRoot, '.glafka');
  withDevCmd(repoRoot);
  const one = await provisioned(repoRoot, stateDir);
  const two = await provisioned(repoRoot, stateDir);
  t.after(() => {
    stopDevServer({ stateDir, id: one.id });
    stopDevServer({ stateDir, id: two.id });
  });
  await stopAndWait(stateDir, one.id);
  await stopAndWait(stateDir, two.id);

  const notes: string[] = [];
  const realLog = console.log;
  console.log = (msg: string) => notes.push(String(msg));
  try {
    await captureStderr(() =>
      runVima({ args: ['--all', '--restart'], stateDir, repoRoot, config: tickConfig() }),
    );
  } finally {
    console.log = realLog;
  }

  assert.equal(devServerAlive({ stateDir, id: one.id }), true);
  assert.equal(devServerAlive({ stateDir, id: two.id }), true);
  // One parseable line per ticket, and it says what happened to each.
  assert.match(notes.join('\n'), new RegExp(`${one.id}  started`));
  assert.match(notes.join('\n'), new RegExp(`${two.id}  started`));
});

test('--all --restart on a project with no app changes nothing', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = path.join(repoRoot, '.glafka');
  const ticket = await provisioned(repoRoot, stateDir);

  const notes: string[] = [];
  const realLog = console.log;
  console.log = (msg: string) => notes.push(String(msg));
  try {
    await runVima({ args: ['--all', '--restart'], stateDir, repoRoot, config: tickConfig() });
  } finally {
    console.log = realLog;
  }

  assert.match(notes.join('\n'), new RegExp(`${ticket.id}  no-dev-cmd`));
  assert.equal(devServerAlive({ stateDir, id: ticket.id }), false);
});

// An app that sat through SIGKILL still holds this ticket's ports. Starting a
// second copy on top of it leaves two, and reads the old socket as ready.
test('a restart that could not stop the old app starts no new one', () => {
  const notes: string[] = [];
  const realError = console.error;
  console.error = (msg: string) => notes.push(String(msg));
  try {
    reportDevServer('not-stopped', {
      stateDir: '/nowhere',
      id: '2026-08-07-restart-the-app',
      ports: [],
    });
  } finally {
    console.error = realError;
  }

  assert.match(notes.join('\n'), /not restarted/);
  // Not "not ready": nothing new was ever started, so there is no run of its
  // own to blame and no log of one to print.
  assert.doesNotMatch(notes.join('\n'), /last output/);
});

// The reported race: a caller whose app never came up spends ~4s stopping it,
// and a second caller must not start on the ports it is still letting go of.
test('a start waits for a failed start to finish stopping', async (t) => {
  const repoRoot = makeGitRepo();
  const stateDir = path.join(repoRoot, '.glafka');
  const startLog = path.join(makeTempDir('devstarts'), 'starts');
  // Provisioned with a working app, so only the two calls below pay a wait.
  withDevCmd(repoRoot);
  const ticket = await provisioned(repoRoot, stateDir);
  t.after(() => stopDevServer({ stateDir, id: ticket.id }));
  await stopAndWait(stateDir, ticket.id);
  // From here it never listens and sits through SIGTERM, so a failed start's
  // stop really spends its whole grace.
  withDevCmd(repoRoot, { devCmd: neverReady(startLog, { deafToSigterm: true }) });

  const { pidPath } = runFiles(stateDir, ticket.id, DEV_ROLE);
  const first = ensureDevServer({ stateDir, repoRoot, ticket, timeoutMs: 500 });
  await until(() => fs.existsSync(pidPath));
  const firstGroup = Number(fs.readFileSync(pidPath, 'utf8'));
  // The pid file goes the moment the stop begins. That is the window this test
  // is about: the app itself is deaf to SIGTERM and lives on for ~3s more.
  await until(() => !fs.existsSync(pidPath));
  assert.equal(groupAlive(firstGroup), true, 'the first app must outlive its own SIGTERM here');

  const second = ensureDevServer({ stateDir, repoRoot, ticket, timeoutMs: 500 });
  await until(() => fs.existsSync(pidPath));

  // Read the instant the second start wrote its pid. Unguarded it would land
  // here with the first app still holding this ticket's ports.
  assert.equal(groupAlive(firstGroup), false, 'a second app started on top of a live one');
  assert.equal(await first, 'not-ready');
  assert.equal(await second, 'not-ready');
  assert.equal(startCount(startLog), 2);
});

// A tick used to ensure twice: once itself, then again inside the coder spawn
// with the full 60s. One broken app cost a tick ~70s and two starts.
test('a tick ensures the app once, not once per step', async (t) => {
  const repoRoot = makeGitRepo();
  const stateDir = path.join(repoRoot, '.glafka');
  const startLog = path.join(makeTempDir('devstarts'), 'starts');
  withDevCmd(repoRoot);
  const ticket = await provisioned(repoRoot, stateDir);
  t.after(() => stopDevServer({ stateDir, id: ticket.id }));
  await stopAndWait(stateDir, ticket.id);
  withDevCmd(repoRoot, { devCmd: neverReady(startLog) });

  const config = { ...tickConfig(), agents: { coder: 'true' } };
  const startedAt = Date.now();
  const result = await captureStderr(() => vima({ stateDir, id: ticket.id, repoRoot, config }));
  const elapsed = Date.now() - startedAt;

  // It really did reach the coder, or the second ensure was never on the path.
  assert.equal(result.value.action, 'spawned-coder');
  assert.equal(result.value.dev, 'not-ready');
  assert.equal(startCount(startLog), 1, 'the app was started twice in one tick');
  assert.ok(
    elapsed < DEFAULT_READY_TIMEOUT_MS,
    `took ${elapsed}ms — a tick paid the full provisioning wait as well as its own`,
  );
});

// Reachable after a partial Ctrl-C cleanup: the worktree is on disk, its ticket
// file is not, and its app is still running on the ports being given back.
test('sweeping an orphan worktree stops its app first', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = path.join(repoRoot, '.glafka');
  const pidFile = path.join(makeTempDir('devpid'), 'pid');
  withDevCmd(repoRoot, { devCmd: recordsItsPid(pidFile) });
  const ticket = await provisioned(repoRoot, stateDir);
  assert.equal(devServerAlive({ stateDir, id: ticket.id }), true);
  const appPid = Number(fs.readFileSync(pidFile, 'utf8'));

  // Pretend the ticket file never landed. Only the worktree is left.
  fs.rmSync(ticketFiles(ticketsDir(stateDir), ticket.id).ticketFile);
  const { orphans } = findOrphans({ repoRoot, stateDir });
  const worktree = orphans.find((orphan) => orphan.kind === 'worktree')!;
  await purgeOrphan({ repoRoot, stateDir, orphan: worktree });

  // Dead by the time the purge returned, not merely signalled and left.
  assert.equal(isAlive(appPid), false, `pid ${appPid} outlived the sweep`);
});

// The ticket reserved one port before the profile listed any service, so its
// ports live under `port` and there is no isolationPorts map to read them from.
test('a ticket carrying only a port still tells the app which port to use', async (t) => {
  const repoRoot = makeGitRepo();
  const stateDir = path.join(repoRoot, '.glafka');
  // No profile at all, so the ticket gets a single `port`.
  const ticket = await provisioned(repoRoot, stateDir);
  t.after(() => stopDevServer({ stateDir, id: ticket.id }));

  // Now the profile has a service, and its name is NOT PORT. Nothing else can
  // tell the app where to listen.
  withDevCmd(repoRoot, {
    services: [{ name: 'web', envVars: ['WEB_PORT'] }],
    devCmd:
      'node -e "if(!process.env.WEB_PORT) process.exit(1);' +
      " require('net').createServer().listen(process.env.WEB_PORT); setInterval(()=>{},1000)\"",
  });

  const outcome = await ensureDevServer({ stateDir, repoRoot, ticket, timeoutMs: 10_000 });

  assert.equal(outcome, 'started');
  assert.equal(devServerAlive({ stateDir, id: ticket.id }), true);
});

test('the report a person reads says whether the app is running', async (t) => {
  const repoRoot = makeGitRepo();
  const stateDir = path.join(repoRoot, '.glafka');
  withDevCmd(repoRoot);
  const ticket = await provisioned(repoRoot, stateDir);
  t.after(() => stopDevServer({ stateDir, id: ticket.id }));

  // repoRoot is what makes the app knowable here. Without it there is no
  // profile to read and the line was silently never shown.
  assert.match(logos({ stateDir, id: ticket.id, repoRoot }).raw, /App: running/);

  await stopAndWait(stateDir, ticket.id);
  assert.match(logos({ stateDir, id: ticket.id, repoRoot }).raw, /App: not running/);
});

test('a project with no app gains no app line in the report', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = path.join(repoRoot, '.glafka');
  const ticket = await provisioned(repoRoot, stateDir);

  assert.doesNotMatch(logos({ stateDir, id: ticket.id, repoRoot }).raw, /App:/);
});

// I2: the QA tester cannot restart the app (every guardrails level refuses `vima`), so glafka
// makes sure it is up before the tester starts.
test('ergon --review brings the app back before it starts the QA tester', async (t) => {
  const repoRoot = makeGitRepo();
  const stateDir = path.join(repoRoot, '.glafka');
  withDevCmd(repoRoot);
  const created = createTicket({ stateDir, repoRoot, content: `add a thing ${++thing}` });
  const spec = writeFile('# T\n\n## Acceptance criteria\n\n- AC-1: a → b → c\n');
  attachSpec({ stateDir, repoRoot, id: created.id, specPath: spec, title: 'A thing' });
  const plan = writeFile('## Task 1: do it\n\n- [ ] **Step 1: go**\n');
  const ticket = await attachPlan({ stateDir, repoRoot, id: created.id, planPath: plan });
  t.after(() => {
    killBackground({ stateDir, id: ticket.id, role: 'verifier' });
    stopDevServer({ stateDir, id: ticket.id });
  });
  fs.writeFileSync(path.join(ticket.worktree!, 'done.txt'), 'x\n');
  execFileSync('git', ['add', 'done.txt'], { cwd: ticket.worktree! });
  execFileSync('git', ['commit', '-q', '-m', 'did it'], { cwd: ticket.worktree! });
  await stopAndWait(stateDir, ticket.id);

  const config = {
    baseRef: 'main',
    checksCmd: null,
    e2eCmd: null,
    checksTimeoutMs: 10_000,
    e2eTimeoutMs: 10_000,
    ergonTimeoutMs: 60_000,
    agents: { verifier: 'cat > /dev/null' },
    maxReviewRounds: 3,
    notifyCmd: null,
    reviewDoc: null,
    observability: { enabled: false },
  } as unknown as Config;
  const args = [ticket.id, '--review'];
  await captureStderr(() =>
    runErgon({ args, repoRoot, stateDir, config, personaContent: null, profile: null }),
  );

  assert.equal(devServerAlive({ stateDir, id: ticket.id }), true);
  assert.notEqual(
    backgroundStatus({ stateDir, id: ticket.id, role: 'verifier' }).state,
    'not-started',
  );
});
