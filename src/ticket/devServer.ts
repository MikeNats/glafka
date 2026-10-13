import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';

import { runFiles, ticketScratchPath } from './paths.js';
import { isAlive, signalTree } from './background.js';
import { processStartTimeMs, sameProcessStart } from '../util/process.js';
import { sleepSync, withFileLockAsync } from '../util/fileOperations.js';
import { shellPath } from '../util/shell.js';
import { readIsolationProfile } from '../memory/docsStore.js';
import { servicesOf, envFor, portEnv, readTicketEnv } from './resources/ticketEnv.js';
import type { IsolationProfileLike } from './resources/ticketEnv.js';

// The app's process is tracked like any other run for a ticket, under its own
// role, so it never collides with the coder's or the reviewer's files.
export const DEV_ROLE = 'dev';

// How long to wait for the app before giving up and saying so.
export const DEFAULT_READY_TIMEOUT_MS = 60_000;

const POLL_INTERVAL_MS = 250;
const PORT_PROBE_TIMEOUT_MS = 500;

// How long one run of the health command may take before it is killed off.
const HEALTH_TIMEOUT_MS = PORT_PROBE_TIMEOUT_MS * 4;

// Both streams go to one file. Half the reason an app failed to start is
// usually on stderr.
const SPAWN_SCRIPT = '"$@" > "$GLAFKA_LOG_FILE" 2>&1';

interface StartArgs {
  stateDir: string;
  id: string;
  cmd: string;
  cwd: string;
  env?: Record<string, string>;
}

// Starts the app and records what is needed to find it again later.
export function startDevServer({ stateDir, id, cmd, cwd, env = {} }: StartArgs): {
  pid: number | undefined;
  logPath: string;
} {
  const { dir, pidPath, logPath, startedAtPath, startProofPath } = runFiles(stateDir, id, DEV_ROLE);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(logPath, '');
  fs.rmSync(startProofPath, { force: true });

  // The app's temp folder, outside the repo. releaseResources removes it.
  const scratch = ticketScratchPath(id);
  fs.mkdirSync(scratch, { recursive: true });

  const shell = shellPath();
  const child = spawn(shell, ['-c', SPAWN_SCRIPT, shell, shell, '-c', cmd], {
    detached: true,
    stdio: 'ignore',
    cwd,
    env: {
      ...process.env,
      ...env,
      GLAFKA_TICKET_ID: id,
      GLAFKA_LOG_FILE: logPath,
      TMPDIR: scratch,
    },
  });
  // A folder that vanished reports itself as an event, long after this returns.
  child.on('error', (err) => {
    try {
      fs.appendFileSync(logPath, `failed to start: ${err.message}\n`);
    } catch {
      // Reporting a failure must not cause a second failure.
    }
  });
  child.unref();

  if (typeof child.pid === 'number') {
    fs.writeFileSync(pidPath, String(child.pid));
    fs.writeFileSync(startedAtPath, String(Date.now()));
    // The system reuses process ids. This is what later proves the pid on file
    // is still the process we started, and not a stranger's.
    const proof = processStartTimeMs(child.pid);
    if (proof != null) fs.writeFileSync(startProofPath, String(proof));
  }
  return { pid: child.pid, logPath };
}

// The recorded pid, or null when nothing was ever started.
function devPid(stateDir: string, id: string): number | null {
  const { pidPath } = runFiles(stateDir, id, DEV_ROLE);
  if (!fs.existsSync(pidPath)) return null;
  const pid = Number(fs.readFileSync(pidPath, 'utf8'));
  return Number.isInteger(pid) && pid > 1 ? pid : null;
}

// Alive AND still the process we started. A pid alone is not enough:
// after a reboot the system may have given it to something unrelated.
export function devServerAlive({ stateDir, id }: { stateDir: string; id: string }): boolean {
  const pid = devPid(stateDir, id);
  if (pid == null) return false;
  // The recorded pid is the wrapper shell, and the app outlives it. No proof to check here — that
  // names the leader, which is gone; a reused group id keeps a live leader and fails the proof below.
  if (!isAlive(pid)) return treeAlive(pid);

  const { startProofPath } = runFiles(stateDir, id, DEV_ROLE);
  if (!fs.existsSync(startProofPath)) return true;
  const current = processStartTimeMs(pid);
  // The system would not answer just now. That is not proof of reuse.
  if (current == null) return true;
  return sameProcessStart(Number(fs.readFileSync(startProofPath, 'utf8')), current);
}

// Sends the signal and returns. False when there was nothing to stop. Anything
// that must know the app has really gone wants stopDevServerAndWait below.
export function stopDevServer({ stateDir, id }: { stateDir: string; id: string }): boolean {
  if (!devServerAlive({ stateDir, id })) return false;
  const pid = devPid(stateDir, id);
  if (pid == null) return false;
  const signalled = signalTree(pid, 'SIGTERM');
  fs.rmSync(runFiles(stateDir, id, DEV_ROLE).pidPath, { force: true });
  return signalled;
}

// How long the app gets to shut down after SIGTERM. Enough for a server to let
// go of a database, short enough that a close never feels stuck.
export const STOP_GRACE_MS = 3_000;

// How long SIGKILL gets. The system does not ask, so this only covers the gap
// between the signal and the process leaving the table.
export const KILL_GRACE_MS = 1_000;

const EXIT_POLL_MS = 100;

// Is anything still a child of `pid`? Windows leaves that link in place when the
// parent dies, which is the only reason a killed leader's tree stays findable.
export function hasLiveChild(parents: Map<number, number>, pid: number): boolean {
  for (const parent of parents.values()) {
    if (parent === pid) return true;
  }
  return false;
}

// Every process on the machine as child -> parent. Null when the host would
// not answer, which the caller must not read as a tree that has emptied.
function windowsProcessParents(): Map<number, number> | null {
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const parents = new Map<number, number>();
    for (const line of out.split('\n')) {
      const [child, parent] = line.trim().split(/\s+/).map(Number);
      if (Number.isInteger(child) && Number.isInteger(parent)) parents.set(child, parent);
    }
    return parents;
  } catch {
    return null;
  }
}

// Anything still in the app's process group. The recorded pid is the wrapper
// shell, so the app is a child of it and only the group covers both.
function treeAlive(pid: number): boolean {
  if (process.platform === 'win32') {
    // Windows has no process group, so a partial `taskkill /T` used to read as
    // "gone" the moment the leader went. Ask about its children too.
    if (isAlive(pid)) return true;
    const parents = windowsProcessParents();
    // No answer is the leader alone, which is all this ever had before.
    return parents === null ? false : hasLiveChild(parents, pid);
  }
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    // EPERM means alive but not ours. Only ESRCH means the group is empty.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// Waits for the group to empty, or gives up when the budget is spent.
async function waitForTreeExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (treeAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, EXIT_POLL_MS));
  }
  return true;
}

// The same wait, blocking. It can only see an app THIS process did not start:
// its own children are reaped by the event loop, which a blocked one never runs.
function waitForTreeExitSync(pid: number, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  while (treeAlive(pid)) {
    if (Date.now() >= deadline) return false;
    sleepSync(EXIT_POLL_MS);
  }
  return true;
}

// Stops the app and waits for it to really go, SIGKILL if it will not. Bounded
// by STOP_GRACE_MS + KILL_GRACE_MS, because a close is never blocked by it.
export async function stopDevServerAndWait({
  stateDir,
  id,
}: {
  stateDir: string;
  id: string;
}): Promise<boolean> {
  // Read the pid BEFORE stopping, which deletes the pid file. Only a pid
  // devServerAlive vouched for is safe to wait on and later kill.
  const pid = devServerAlive({ stateDir, id }) ? devPid(stateDir, id) : null;
  stopDevServer({ stateDir, id });
  if (pid == null) return true;

  if (await waitForTreeExit(pid, STOP_GRACE_MS)) return true;

  // It sat through SIGTERM. Its ports and whatever it holds are being given
  // back now, so it does not get to stay.
  signalTree(pid, 'SIGKILL');
  if (await waitForTreeExit(pid, KILL_GRACE_MS)) return true;

  warnStillRunning(id, pid);
  return false;
}

function warnStillRunning(id: string, pid: number): void {
  console.error(
    `warning: the app for ${id} (pid ${pid}) is still running after SIGKILL — it may still be ` +
      `holding this ticket's ports or its database. Stop it by hand: kill -9 -${pid}`,
  );
}

// How long the app gets between the two signals when there is no way to watch
// it. Short: this is the Ctrl-C path, and pressing it means stop now.
export const SIGNAL_STOP_GRACE_MS = 500;

// The stop a signal handler can use, which cannot await. SIGTERM, a blocking
// pause, then SIGKILL, which nothing can ignore. Returns whether it stopped one.
export function stopDevServerNow({ stateDir, id }: { stateDir: string; id: string }): boolean {
  const pid = devServerAlive({ stateDir, id }) ? devPid(stateDir, id) : null;
  if (!stopDevServer({ stateDir, id }) || pid == null) return false;

  // An app this process started reads as alive until the loop turns, so the
  // whole pause is spent there and the SIGKILL below lands on a dead group.
  if (waitForTreeExitSync(pid, SIGNAL_STOP_GRACE_MS)) return true;

  // Nothing here can watch this land, so nothing here may claim it did.
  signalTree(pid, 'SIGKILL');
  return true;
}

// The end of the app's output, for an error message that has to explain itself.
export function readDevLogTail({
  stateDir,
  id,
  lines = 40,
}: {
  stateDir: string;
  id: string;
  lines?: number;
}): string | null {
  const { logPath } = runFiles(stateDir, id, DEV_ROLE);
  try {
    const text = fs.readFileSync(logPath, 'utf8').trimEnd();
    return text === '' ? null : text.split('\n').slice(-lines).join('\n');
  } catch {
    return null;
  }
}

// Both loopback addresses. An app may bind only one of them, and either one
// answering means it is listening.
const PROBE_HOSTS = ['127.0.0.1', '::1'];

function connects(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (answer: boolean) => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(PORT_PROBE_TIMEOUT_MS);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

// Is anything listening there yet? A connection that opens is the answer.
async function portListening(port: number): Promise<boolean> {
  const answers = await Promise.all(PROBE_HOSTS.map((host) => connects(port, host)));
  return answers.some(Boolean);
}

// Runs the health command and answers whether it succeeded. A command that
// hangs is killed off with everything it started.
function healthPasses(
  healthCmd: string,
  cwd: string,
  env: Record<string, string>,
): Promise<boolean> {
  return new Promise((resolve) => {
    // A group leader, so the timeout below reaches its children too.
    const child = spawn(shellPath(), ['-c', healthCmd], {
      cwd,
      env: { ...process.env, ...env },
      stdio: 'ignore',
      detached: true,
    });

    const timer = setTimeout(() => {
      // Killing the shell alone would leave whatever it started behind, and
      // every later poll would add one more.
      if (child.pid != null) signalTree(child.pid, 'SIGKILL');
    }, HEALTH_TIMEOUT_MS);

    const finish = (answer: boolean) => {
      clearTimeout(timer);
      resolve(answer);
    };
    child.once('exit', (code) => finish(code === 0));
    // The shell itself could not be started. That is not a pass.
    child.once('error', () => finish(false));
  });
}

// Waits until the app answers, or the time runs out. `healthCmd` wins when it
// is given: a port can be bound before the app is really serving.
export async function waitForReady({
  ports = [],
  healthCmd = null,
  cwd,
  env = {},
  timeoutMs = DEFAULT_READY_TIMEOUT_MS,
}: {
  ports?: number[];
  healthCmd?: string | null;
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}): Promise<boolean> {
  // Nothing to watch. Say so rather than blocking for the whole timeout.
  if (!healthCmd && ports.length === 0) return false;

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (healthCmd) {
      if (await healthPasses(healthCmd, cwd, env)) return true;
    } else {
      const answers = await Promise.all(ports.map(portListening));
      if (answers.every(Boolean)) return true;
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

// --------------------------------------------------------------------------- The ticket's app

// 'no-worktree' is kept apart from 'not-ready' because nothing was started,
// so this run has no output of its own and the reason is already known.
export type DevServerOutcome =
  | 'started'
  | 'already-running'
  | 'not-ready'
  // The old app sat through SIGKILL, so a restart never started a new one.
  | 'not-stopped'
  | 'no-worktree'
  | 'no-dev-cmd';

// The little a dev server needs to know about a ticket. A stored ticket fits,
// and so does the stand-in acquireResources builds before one is written.
export interface DevServerTicket {
  id: string;
  worktree: string | null;
  isolationPorts?: Record<string, number> | null;
  port?: number | null;
}

// How long to wait between two checks that the app's process is still there.
const ALIVE_CHECK_SLICE_MS = 1_000;

// A start and a failed start's stop share this lock, so a waiter has to outlast
// a whole stop. The default ~2s budget is shorter than one, and would give up.
const DEV_LOCK_DELAY_MS = 20;
const DEV_LOCK_OPTIONS = {
  delayMs: DEV_LOCK_DELAY_MS,
  retries: Math.ceil((STOP_GRACE_MS + KILL_GRACE_MS + 4_000) / DEV_LOCK_DELAY_MS),
};

// The ports this ticket owns, which is what readiness watches when the
// project gave no healthCmd, and what every dev-server report names.
export function ticketPorts(ticket: DevServerTicket): number[] {
  const isolation = Object.values(ticket.isolationPorts ?? {});
  if (isolation.length > 0) return isolation;
  return typeof ticket.port === 'number' ? [ticket.port] : [];
}

// The env the app is started with, so it uses the ports glafka reserved
// rather than this project's usual hardcoded ones.
function devEnv(
  repoRoot: string,
  worktree: string,
  ticket: DevServerTicket,
  profile: IsolationProfileLike | null,
): Record<string, string> {
  const env = portEnv(profile, ticket.isolationPorts);
  const services = servicesOf(profile);
  // This ticket reserved one port, not one per service. It is always PORT, and
  // also the one service's own names when the profile lists exactly one.
  if (Object.keys(env).length === 0 && typeof ticket.port === 'number') {
    env.PORT = String(ticket.port);
    if (services.length === 1) Object.assign(env, envFor(services[0]!, ticket.port));
  }
  // The file goes underneath: a DATABASE_URL setupCmd made reaches the app,
  // but a stale line in it can never beat the ports this ticket really holds.
  return {
    ...readTicketEnv(worktree),
    ...env,
    GLAFKA_TICKET_ID: ticket.id,
    GLAFKA_REPO_ROOT: repoRoot,
    GLAFKA_WORKTREE: worktree,
  };
}

// devCmd has to stay in the foreground, so a process that is already gone will
// never become ready. Waiting in slices lets us stop instead of sitting it out.
async function waitReadyWhileAlive({
  stateDir,
  id,
  ports,
  healthCmd,
  cwd,
  env,
  timeoutMs,
}: {
  stateDir: string;
  id: string;
  ports: number[];
  healthCmd: string | null;
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}): Promise<boolean> {
  // Nothing to watch, so readiness can never be answered. Say so rather than
  // asking the same unanswerable question until the time runs out.
  if (!healthCmd && ports.length === 0) return false;

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const slice = Math.min(ALIVE_CHECK_SLICE_MS, deadline - Date.now());
    if (await waitForReady({ ports, healthCmd, cwd, env, timeoutMs: slice })) return true;
    if (Date.now() >= deadline) return false;
    if (!devServerAlive({ stateDir, id })) return false;
  }
}

// A profile we cannot read means we cannot know there is an app, so we say so
// and carry on. Nothing is being torn down here, unlike the reader below.
function readProfileForApp(repoRoot: string): IsolationProfileLike | null {
  try {
    return readIsolationProfile(repoRoot) as IsolationProfileLike | null;
  } catch (err) {
    console.error(
      `warning: the isolation profile could not be read, so this ticket's app is not being ` +
        `started. Everything else about the ticket is unaffected. ` +
        `Cause: ${(err as Error).message}`,
    );
    return null;
  }
}

// Makes sure this ticket's app is running, and says what it had to do.
// Safe to call on every command: an app already up is left alone.
export async function ensureDevServer({
  stateDir,
  repoRoot,
  ticket,
  profile = undefined,
  timeoutMs = DEFAULT_READY_TIMEOUT_MS,
}: {
  stateDir: string;
  repoRoot: string;
  ticket: DevServerTicket;
  profile?: IsolationProfileLike | null;
  timeoutMs?: number;
}): Promise<DevServerOutcome> {
  const resolved = profile === undefined ? readProfileForApp(repoRoot) : profile;
  const devCmd = resolved?.devCmd;
  if (!devCmd) return 'no-dev-cmd';
  if (devServerAlive({ stateDir, id: ticket.id })) return 'already-running';
  // A worktree that is gone cannot run anything, and spawn would report it
  // far too late to be useful.
  const worktree = ticket.worktree;
  if (!worktree || !fs.existsSync(worktree)) return 'no-worktree';

  const env = devEnv(repoRoot, worktree, ticket, resolved);

  // Checking and spawning as one step, so two callers at once cannot both
  // start an app and leave the first one untracked on this ticket's ports.
  const { lockPath } = runFiles(stateDir, ticket.id, DEV_ROLE);
  const spawned = await withFileLockAsync(
    lockPath,
    async (lease) => {
      // Asked again in here: the answer above was read outside the lock.
      if (devServerAlive({ stateDir, id: ticket.id })) return false;
      // A spawn cannot be undone, so prove the lock is still ours first.
      lease.assertHeld();
      startDevServer({ stateDir, id: ticket.id, cmd: devCmd, cwd: worktree, env });
      return true;
    },
    DEV_LOCK_OPTIONS,
  );
  // Someone else got there between the two checks. Their app is the one.
  if (!spawned) return 'already-running';

  // Outside the lock on purpose. A wait this long can outlast the lease, and a
  // lock taken over mid-wait reopens the very race the lock closes.
  const ready = await waitReadyWhileAlive({
    stateDir,
    id: ticket.id,
    ports: ticketPorts(ticket),
    healthCmd: resolved?.healthCmd ?? null,
    cwd: worktree,
    env,
    timeoutMs,
  });
  if (ready) return 'started';

  // It did not come up. Stopped under the same lock a start takes, so a second
  // caller waits instead of starting on ports this one is still letting go of
  // and reading the dying socket as its own `ready`.
  const stop = () => stopDevServerAndWait({ stateDir, id: ticket.id });
  try {
    await withFileLockAsync(lockPath, stop, DEV_LOCK_OPTIONS);
  } catch {
    // The lock could not be had. The app still has to go.
    await stop();
  }
  return 'not-ready';
}

// Says what happened, in the shape every other failure here uses: what, where,
// what it printed, what to do next. Never throws — the ticket is still fine.
export function reportDevServer(
  outcome: DevServerOutcome,
  { stateDir, id, ports }: { stateDir: string; id: string; ports: number[] },
): void {
  if (outcome === 'no-dev-cmd' || outcome === 'already-running') return;
  if (outcome === 'started') {
    console.error(`  dev        ready${ports.length > 0 ? ` on ${ports.join(', ')}` : ''}`);
    return;
  }
  // Nothing ran, so the log still holds an older run. Showing it here would
  // blame this failure on output that has nothing to do with it.
  if (outcome === 'no-worktree') {
    console.error(`  dev        ⚠ not started — the worktree for ${id} is gone`);
    return;
  }
  // Nothing new ran either. stopDevServerAndWait has already named the pid and
  // the command to kill it, so this only says what it meant for the restart.
  if (outcome === 'not-stopped') {
    console.error(`  dev        ⚠ not restarted — the old app would not stop, so none was started`);
    return;
  }
  console.error(`  dev        ⚠ not ready`);
  const tail = readDevLogTail({ stateDir, id });
  if (tail) console.error(`\n  last output:\n${tail}\n`);
  console.error(`  The ticket is fine. The app is not running.`);
  console.error(`  Logs:  ${runFiles(stateDir, id, DEV_ROLE).logPath}`);
  console.error(`  Retry: glafka vima ${id} --restart`);
}
