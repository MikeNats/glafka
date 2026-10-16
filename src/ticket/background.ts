import { spawn, spawnSync } from 'node:child_process';
import { ROLES } from '../types/ticket.js';
import fs from 'node:fs';
import { runFiles, ticketScratchPath } from './paths.js';
import { processStartTimeMs, sameProcessStart } from '../util/process.js';
import { isDescendantOf } from '../util/processAncestry.js';
import { descendantPids, pidsInGroup } from '../util/processTree.js';
import {
  buildEnv,
  wrap as cage,
  proxyEnv,
  type Policy,
} from '../../installKit/guardrails/index.js';
import { shellArgv, shellPath } from '../util/shell.js';
import { readTicketEnv } from './resources/ticketEnv.js';
import { agentName, SESSION_AGENT } from '../audit/parseUsage.js';
import { withUsageFlags } from '../audit/usageFlags.js';
import { withLeanStart } from '../util/leanStart.js';
import { recordBackgroundRun } from '../audit/recordRun.js';
import { isRole } from '../types/ticket.js';

const DEFAULT_STALE_MS = 10 * 60 * 1000;

// These states mean the run is still going.
// Wait for them before touching the worktree.
export const RUNNING_STATES: Set<string> = new Set(['running', 'stalled', 'timed-out']);

// File paths come in as env vars, not arguments,
// so "$@" stays just the command to run.
const SPAWN_SCRIPT =
  '"$@" < "$GLAFKA_PROMPT_FILE" > "$GLAFKA_LOG_FILE" 2>&1; echo $? > "$GLAFKA_EXIT_FILE"';

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means alive but owned by someone else. Only ESRCH means dead.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// The run never started, and trying again now will not help.
// It is a type, not words in a message, so code can act on it safely.
export class RunNotStartedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunNotStartedError';
  }
}

export interface BackgroundGuardrailsInfo {
  backend: string;
  note: string;
  failed?: boolean;
  droppedEnv?: number;
  warnings?: string[];
}

interface SpawnBackgroundArgs {
  stateDir: string;
  id: string;
  role?: string;
  agentCmd: string;
  prompt: string;
  // Optional. Left out means "use our own folder", which tests do.
  // Real callers pass the ticket's worktree.
  cwd?: string | null;
  policy?: Policy | null;
}

// `policy` is optional. Without one there is no cage at all.
// `role` says which run this is. It defaults to "coder".
export function spawnBackground({
  stateDir,
  id,
  role = ROLES.CODER,
  agentCmd,
  prompt,
  cwd,
  policy = null,
}: SpawnBackgroundArgs): {
  pid: number | undefined;
  logPath: string;
  guardrails: BackgroundGuardrailsInfo;
} {
  const {
    dir,
    pidPath,
    logPath,
    exitCodePath,
    assumedExitPath,
    promptPath,
    agentPath,
    startedAtPath,
    recordedPath,
    startProofPath,
    killedPath,
  } = runFiles(stateDir, id, role);
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(exitCodePath)) fs.unlinkSync(exitCodePath);
  // This run writes its own exit code, so no previous run's guess may stand.
  if (fs.existsSync(assumedExitPath)) fs.unlinkSync(assumedExitPath);
  // Clears the old "ending saved" marker.
  // This new run has no ending saved yet.
  if (fs.existsSync(recordedPath)) fs.unlinkSync(recordedPath);
  if (fs.existsSync(startProofPath)) fs.unlinkSync(startProofPath);
  // A previous run's kill marker must never describe this one.
  if (fs.existsSync(killedPath)) fs.unlinkSync(killedPath);
  fs.writeFileSync(promptPath, prompt);
  fs.writeFileSync(logPath, '');
  // Recorded now: the process that reads this back at finish is a different
  // one, and cannot see the command we were called with.
  fs.writeFileSync(agentPath, agentName(agentCmd));

  // Named by ticket id only, not role. Coder and reviewer share this folder,
  // but they never run at the same time. releaseResources removes it on close.
  const scratch = ticketScratchPath(id);
  fs.mkdirSync(scratch, { recursive: true });

  // The agent's final env. These paths must not be stripped,
  // because the wrapper shell reads them.
  const shellPaths = {
    GLAFKA_PROMPT_FILE: promptPath,
    GLAFKA_LOG_FILE: logPath,
    GLAFKA_EXIT_FILE: exitCodePath,
  };

  // What provisioning left in this worktree: the reserved ports, and whatever setupCmd
  // derived from them. The prompt told the coder this file exists and left it to read it
  // by hand, so anything it ran reached the project's normal database, not this ticket's.
  const ticketEnv = cwd ? readTicketEnv(cwd) : {};

  let env: NodeJS.ProcessEnv = { ...process.env, ...ticketEnv, ...shellPaths };
  let guardrails: BackgroundGuardrailsInfo = { backend: 'none', note: 'no policy passed' };
  // Only the argv changes. Everything downstream that identifies the agent —
  // the cage, the credential mapping — still reads the command you configured.
  let argv = shellArgv(withLeanStart(withUsageFlags(agentCmd), role));

  if (policy) {
    if (!cwd) {
      throw new Error(
        'spawnBackground: cwd is required when a policy is passed (cage needs a worktree to scope to)',
      );
    }
    const built = buildEnv(
      policy,
      process.env,
      {
        ...ticketEnv,
        ...shellPaths,
        GLAFKA_TICKET_ID: id,
        TMPDIR: scratch,
        // Pass the real path. TMPDIR is already the scratch folder here,
        // so working it out again would go one level too deep.
        GLAFKA_TICKET_SCRATCH: scratch,
        ...proxyEnv(policy, process.env),
      },
      // Which agent this really is, so a credential that belongs to a
      // different one is not handed over.
      { agentCmd },
    );
    env = built.env;

    // The cage goes on last, so it wraps the real final command.
    const caged = cage(policy, argv, { worktree: cwd, scratch, env, stateDir });

    // A cage that was asked for and did not start makes the run WRONG,
    // not just weaker. We refuse here so no caller can forget to check.
    if (policy.sandbox.enabled && caged.failed) {
      throw new RunNotStartedError(
        `guardrails level ${policy.level} asks for a sandbox and it could not be started ` +
          `(${caged.note}) — refusing to run the agent uncaged. Fix the backend, or lower ` +
          `the level in docs/glafka/guardrails.json if you accept running without one.`,
      );
    }

    argv = caged.argv;
    guardrails = {
      backend: caged.backend,
      note: caged.note,
      failed: caged.failed ?? false,
      droppedEnv: built.dropped.length,
      warnings: built.warnings,
    };
  }

  // spawn() reports a bad folder later, as an event, which crashes the whole
  // process. So we check the folder up front instead.
  if (cwd && !fs.existsSync(cwd)) {
    throw new RunNotStartedError(
      `cannot start the ${role} run for ${id}: its working directory does not exist (${cwd}) — ` +
        `the worktree was moved or removed`,
    );
  }

  // An exit-code file means a clean finish. No file means a crash.
  // The shell writes it, because this CLI exits right after this.
  const shell = shellPath();
  const child = spawn(shell, ['-c', SPAWN_SCRIPT, shell, ...argv], {
    detached: true,
    stdio: 'ignore',
    cwd: cwd ?? undefined,
    env,
  });
  // A safety net for what the check above can not see.
  // We save it as a crashed run instead of killing the whole loop.
  child.on('error', (err) => {
    try {
      fs.writeFileSync(logPath, `failed to start: ${err.message}\n`);
    } catch {
      // Reporting a failure must not cause a second failure.
    }
  });
  child.unref();

  // Writing "undefined" here would read back as a broken number,
  // and the run would look crashed when it never started.
  if (typeof child.pid === 'number') {
    fs.writeFileSync(pidPath, String(child.pid));
    fs.writeFileSync(startedAtPath, String(Date.now()));
    // The OS's own record of this pid's start time, captured while it is still definitely ours. A later check compares against this instead
    const proof = processStartTimeMs(child.pid);
    if (proof != null) fs.writeFileSync(startProofPath, String(proof));
  }
  return { pid: child.pid, logPath, guardrails };
}

// True when `pid` is alive AND, whenever we have a start-time proof on file for it, that proof still matches the OS's current record — i.e.
function isOurs(pid: number, startProofPath: string): boolean {
  if (!isAlive(pid)) return false;
  if (!fs.existsSync(startProofPath)) return true;
  const recorded = Number(fs.readFileSync(startProofPath, 'utf8'));
  const current = processStartTimeMs(pid);
  // Can't prove it right now (ps hiccuped) — do not treat that as reuse.
  if (current == null) return true;
  return sameProcessStart(recorded, current);
}

// Ends the run and every process under it. Returns whether the signal really went out — a caller
// that records "timed out, killed" must not say so when nothing was killed. The two platforms need
// different mechanisms, not different spellings of one. On POSIX a negative pid means the process
// group, which is how the agent under the wrapper shell is reached. Windows has no process groups
// in that sense and `spawn(detached)` there makes a console rather than a group, so
// `process.kill(-pid)` reaches nothing at all; `taskkill /T` walks the tree.
export function signalTree(pid: number, signal: NodeJS.Signals): boolean {
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return result.status === 0;
  }
  // Read BEFORE signalling anything: once the group signal below lands, the tree it would have
  // described is already gone, and reading it after would find nothing.
  const descendants = descendantPids(pid);
  let signalledAny = false;
  try {
    // The minus sign signals the whole group, agent included.
    // Signalling one process would only kill the wrapper shell.
    process.kill(-pid, signal);
    signalledAny = true;
  } catch {
    // Already gone, or not ours to signal. The descendant sweep below still runs — a grandchild in
    // its OWN group is not "already gone" just because the original group's leader was.
  }
  // The group signal only reaches processes that kept the group `spawnBackground` gave them. A tool
  // call the agent made is free to start its own — proven of Claude Code's own Bash tool earlier
  // tonight — and one of those survives the line above untouched. Walked and signalled individually
  // so a reviewer's own grandchild does not outlive a run glafka has already called "finished".
  for (const descendant of descendants) {
    try {
      process.kill(descendant, signal);
      signalledAny = true;
    } catch {
      // Already gone. Not a failure — the group signal, or the descendant's
      // own parent dying, may have already taken it down.
    }
  }
  return signalledAny;
}

// Signals the whole process group. A killed run writes no exit code, so it looks exactly like a
// crash — the marker file is what tells the two apart.
//
// Written BEFORE the signal: the process is gone once `signalTree` returns, and a marker written
// after would race a status poll into calling a deliberate stop a crash.
export function killBackground({
  stateDir,
  id,
  role = ROLES.CODER,
  signal = 'SIGTERM',
  // False for a kill nobody chose — the timeout sweep. That caller records
  // `timed-out`, and "stopped by you" would bury the real reason.
  byUser = true,
}: {
  stateDir: string;
  id: string;
  role?: string;
  signal?: NodeJS.Signals;
  byUser?: boolean;
}): boolean {
  const { pidPath, startProofPath, killedPath } = runFiles(stateDir, id, role);
  if (!fs.existsSync(pidPath)) return false;

  // A live process id may not be OUR process. The system reuses ids, so we
  // could kill something unrelated. Check the status first.
  const status = backgroundStatus({ stateDir, id, role });
  if (!RUNNING_STATES.has(status.state)) return false;

  const pid = Number(fs.readFileSync(pidPath, 'utf8'));
  // isOurs, not isAlive: a coder killed by a signal never writes an exit code, so a recycled pid handed to something else entirely would
  if (!Number.isInteger(pid) || pid <= 1 || !isOurs(pid, startProofPath)) return false;
  // Every check above has passed, so this signal is about to go out at a run we own.
  if (byUser) {
    fs.writeFileSync(killedPath, `${JSON.stringify({ at: new Date().toISOString(), signal })}\n`);
  }
  const signalled = signalTree(pid, signal);
  // Nothing was killed after all — the process was already gone. Leaving the
  // marker would relabel a crash that happened on its own as a deliberate stop.
  if (byUser && !signalled && fs.existsSync(killedPath)) fs.unlinkSync(killedPath);
  return signalled;
}

// The pid a caller should show you when a kill did not land, so "it is still
// running" comes with something you can act on. Null when there is no pid file.
export function backgroundPid({
  stateDir,
  id,
  role = ROLES.CODER,
}: {
  stateDir: string;
  id: string;
  role?: string;
}): number | null {
  const { pidPath } = runFiles(stateDir, id, role);
  if (!fs.existsSync(pidPath)) return null;
  const pid = Number(fs.readFileSync(pidPath, 'utf8'));
  return Number.isInteger(pid) ? pid : null;
}

// Self-gating: marks itself done with its OWN file, so it is safe to call on every status check
// without re-scanning `ps` on every poll once a run has already been swept. Deliberately independent
// of `observability` — that setting is about the audit trail, and a leftover OS process is not an
// audit concern; it needs sweeping once whether or not audit logging is on.
//
// A run that glafka calls "finished" wrote its exit code, which means the top-level process is
// already gone. A tool call it made along the way — a Bash command, most obviously — may still be
// alive: nothing waits for it, nothing will ever report on it, and the run it belonged to is over by
// every definition glafka has. This is the "coder reports done, reviewer OS process keeps running"
// case, caught the first time glafka would otherwise stop looking.
//
// Best-effort, not complete: `pidsInGroup` finds a survivor that kept the run's own process group,
// which is the ordinary case. It cannot find one that put itself in a group of its own before this
// run's top-level process exited — reparenting has already erased the link that would prove it came
// from here. Returns what it killed, so a caller that wants to say so can — none does yet.
export function reapOrphans({
  stateDir,
  id,
  role,
}: {
  stateDir: string;
  id: string;
  role: string;
}): number[] {
  // No pid file means either nothing was ever spawned here, or it was dispatched externally
  // (markExternalRunStarted) — no run directory glafka wrote, and nothing of glafka's own to sweep.
  const pid = backgroundPid({ stateDir, id, role });
  if (pid == null) return [];

  const { reapedPath } = runFiles(stateDir, id, role);
  if (fs.existsSync(reapedPath)) return [];
  fs.writeFileSync(reapedPath, new Date().toISOString());

  const survivors = pidsInGroup(pid);
  const killed: number[] = [];
  for (const survivor of survivors) {
    try {
      process.kill(survivor, 'SIGTERM');
      killed.push(survivor);
    } catch {
      // Already gone between listing it and signalling it. Not an error.
    }
  }
  return killed;
}

export type BackgroundStatus =
  | { state: 'not-started' }
  | { state: 'finished' | 'failed'; exitCode: number; logPath: string }
  | { state: 'crashed' | 'cancelled'; logPath: string }
  | { state: 'timed-out'; pid: number | null; runtimeMs: number; logPath: string }
  | { state: 'stalled' | 'running'; ageMs: number; logPath: string };

// Marks a run as having started WITHOUT a pid we control — the documented primary flow (skills/ergon.md) prints the prompt and hands it to the
export function markExternalRunStarted({
  stateDir,
  id,
  role = ROLES.CODER,
  prompt = null,
  agentCmd = null,
}: {
  stateDir: string;
  id: string;
  role?: string;
  // What was handed out, and to what. Null agentCmd means the prompt went to
  // the session reading the terminal, which is a real answer, not a missing one.
  prompt?: string | null;
  agentCmd?: string | null;
}): void {
  const {
    dir,
    pidPath,
    logPath,
    exitCodePath,
    assumedExitPath,
    promptPath,
    agentPath,
    startedAtPath,
    recordedPath,
    startProofPath,
    killedPath,
  } = runFiles(stateDir, id, role);
  fs.mkdirSync(dir, { recursive: true });
  // Clean slate, the same way spawnBackground starts one — a leftover exit
  // code or pid from a previous real run must not be misread as this run's.
  if (fs.existsSync(pidPath)) fs.unlinkSync(pidPath);
  if (fs.existsSync(exitCodePath)) fs.unlinkSync(exitCodePath);
  if (fs.existsSync(assumedExitPath)) fs.unlinkSync(assumedExitPath);
  if (fs.existsSync(recordedPath)) fs.unlinkSync(recordedPath);
  if (fs.existsSync(startProofPath)) fs.unlinkSync(startProofPath);
  if (fs.existsSync(killedPath)) fs.unlinkSync(killedPath);
  if (!fs.existsSync(logPath)) fs.writeFileSync(logPath, '');
  // The same two files spawnBackground writes, so the audit reads one place
  // whichever way the run was dispatched. A previous run's prompt must go.
  if (prompt === null) fs.rmSync(promptPath, { force: true });
  else fs.writeFileSync(promptPath, prompt);
  fs.writeFileSync(agentPath, agentCmd ? agentName(agentCmd) : SESSION_AGENT);
  fs.writeFileSync(startedAtPath, String(Date.now()));
}

// Ends a run that was dispatched externally. A spawned run ends by itself: the child exits, and the
// wrapper writes its exit code. An externally dispatched one has no process glafka owns, so nothing
// ever wrote that file and the run read as "running" for good — `poreia` showed it forever and
// every liveness guard had to warn its way past it. This is the missing
// write. Callers are the moments that prove the coder stopped: it asked for a review, it recorded
// an aporia, or a human closed it by hand with `glafka ergon <id> --finished`. Deliberately a no-op
// for a run glafka spawned itself. That run's real exit code is the truth, and writing over it
// would turn a crash into a clean finish.
export function markExternalRunFinished({
  stateDir,
  id,
  role = ROLES.CODER,
  exitCode = 0,
}: {
  stateDir: string;
  id: string;
  role?: string;
  exitCode?: number;
}): boolean {
  const { pidPath, exitCodePath, assumedExitPath, startedAtPath } = runFiles(stateDir, id, role);
  if (fs.existsSync(pidPath)) return false;
  // Nothing was ever dispatched, so there is no run to end.
  if (!fs.existsSync(startedAtPath)) return false;
  if (fs.existsSync(exitCodePath)) return false;
  fs.writeFileSync(exitCodePath, String(exitCode));
  // This number is glafka's own, taken from what the caller proved (a review
  // was asked for, an aporia was filed) — no process ever reported it.
  fs.writeFileSync(assumedExitPath, '');
  return true;
}

// States: not-started, running, stalled, timed-out, finished, failed, crashed.
export function backgroundStatus({
  stateDir,
  id,
  role = ROLES.CODER,
  staleMs = DEFAULT_STALE_MS,
  maxRuntimeMs = null,
}: {
  stateDir: string;
  id: string;
  role?: string;
  staleMs?: number;
  maxRuntimeMs?: number | null;
}): BackgroundStatus {
  const { pidPath, logPath, exitCodePath, startedAtPath, killedPath } = runFiles(
    stateDir,
    id,
    role,
  );
  const hasPid = fs.existsSync(pidPath);
  // No pid file, but a start marker exists: dispatched externally (see markExternalRunStarted above). Judged the same way a real run is,
  const dispatchedExternally = !hasPid && fs.existsSync(startedAtPath);
  if (!hasPid && !dispatchedExternally) {
    return { state: 'not-started' };
  }

  // An exit code ends the run whichever way it was dispatched. For a spawned run the wrapper writes
  // it; for an external one `markExternalRunFinished` does, which is the only thing that ever takes
  // it out of "running". Both start markers delete a leftover exit code first, so
  // this can never be a previous run's.
  if (fs.existsSync(exitCodePath)) {
    const exitCode = Number(fs.readFileSync(exitCodePath, 'utf8').trim());
    return { state: exitCode === 0 ? 'finished' : 'failed', exitCode, logPath };
  }

  let pid: number | null = null;
  if (hasPid) {
    pid = Number(fs.readFileSync(pidPath, 'utf8'));
    // Plain isAlive here, not the ps-backed ownership check: this runs on every status poll (vima ticks every few minutes, but tests and
    if (!isAlive(pid)) {
      // Read only once the process is really gone, and only on this branch: a
      // marker beside a still-live pid means the signal has not landed yet.
      return { state: fs.existsSync(killedPath) ? 'cancelled' : 'crashed', logPath };
    }
  }

  // Old runs may have no start time. Treat that as unknown, not timed out.
  const startedAt = fs.existsSync(startedAtPath)
    ? Number(fs.readFileSync(startedAtPath, 'utf8'))
    : null;
  const runtimeMs = startedAt == null ? null : Date.now() - startedAt;
  if (maxRuntimeMs != null && runtimeMs != null && runtimeMs > maxRuntimeMs) {
    return { state: 'timed-out', pid, runtimeMs, logPath };
  }

  const ageMs = Date.now() - fs.statSync(logPath).mtimeMs;
  return { state: ageMs > staleMs ? 'stalled' : 'running', ageMs, logPath };
}

// Blocks a command while an agent is still running in the worktree. By default it only looks at the coder, since only the coder writes.
const ROLE_LABEL: Record<string, string> = Object.freeze({ coder: 'ergon' });

// Says whether THIS run's ending is already saved. It is cleared at the start
// of every new run, so it means this run, not ever.
export function hasRecordedOutcome({
  stateDir,
  id,
  role = ROLES.CODER,
}: {
  stateDir: string;
  id: string;
  role?: string;
}): boolean {
  const { recordedPath } = runFiles(stateDir, id, role);
  return fs.existsSync(recordedPath);
}

export function markOutcomeRecorded({
  stateDir,
  id,
  role = ROLES.CODER,
  observability = false,
}: {
  stateDir: string;
  id: string;
  role?: string;
  // Default false so a caller not yet updated records nothing, rather than
  // recording a run with the wrong stage.
  observability?: boolean;
}): void {
  const { recordedPath } = runFiles(stateDir, id, role);
  fs.writeFileSync(recordedPath, '');
  // A hand-edited ticket can name a role we do not know. Skip it rather
  // than record a run under a role that is not one.
  if (isRole(role)) recordBackgroundRun({ stateDir, ticketId: id, role, enabled: observability });
}

export function assertNoLiveRun({
  stateDir,
  id,
  role = ROLES.CODER,
  action,
  risk,
}: {
  stateDir: string;
  id: string;
  role?: string;
  action: string;
  risk: string;
}): BackgroundStatus {
  const status = backgroundStatus({ stateDir, id, role });
  if (!RUNNING_STATES.has(status.state)) return status;

  // A run dispatched externally has no pid, so nothing can ever observe it finishing and it stays
  // in a RUNNING state for good — which would wedge every later command on the ticket. The marker proves a prompt was handed out, not that anything is still writing, so it
  // warns.
  if (!hasPidFile({ stateDir, id, role })) {
    console.error(
      `warning: ticket ${id} has a ${ROLE_LABEL[role] ?? role} run marked started but no process ` +
        `glafka can see (it was dispatched to an agent in your own session). Continuing with ` +
        `${action} — ${risk}. If that agent is still working, stop it first.`,
    );
    return status;
  }

  throw new Error(
    `ticket ${id} has a background ${ROLE_LABEL[role] ?? role} run still ${status.state} — ` +
      `wait for it to finish (or check \`ergon ${id} --status\`) before ${action}; ${risk}`,
  );
}

// Whether THIS process is running inside one of the named runs. The review token proves "someone
// read the round's prompt". It does not prove WHO is calling, so a token copied out of a prompt
// works from anywhere — including from the coder, which is the one caller the whole token exists to
// exclude. A process group is the missing half: `spawnBackground` starts
// each run detached, so the run's pid IS its group id, and only its own descendants share it. Three
// answers, and the difference between them matters: 'inside' — our group is one of the live runs.
// The strong case. 'outside' — live runs exist and we are in none of them. Refuse trust.
// 'unanswerable'— no live run to compare against (the documented manual review path has no reviewer
// process at all), or the OS would not tell us. Fall back to the token alone.
export type CallerOrigin = 'inside' | 'outside' | 'unanswerable';

export function callerRunOrigin({
  stateDir,
  id,
  roles,
}: {
  stateDir: string;
  id: string;
  roles: string[];
}): { origin: CallerOrigin; detail: string } {
  if (process.platform === 'win32') {
    return { origin: 'unanswerable', detail: 'this OS does not report process ancestry' };
  }

  const live: { role: string; pid: number }[] = [];
  for (const role of roles) {
    const { pidPath, startProofPath } = runFiles(stateDir, id, role);
    if (!fs.existsSync(pidPath)) continue;
    const pid = Number(fs.readFileSync(pidPath, 'utf8'));
    // isOurs, not isAlive: a recycled pid must not lend its group to anyone.
    if (Number.isInteger(pid) && isOurs(pid, startProofPath)) live.push({ role, pid });
  }

  if (live.length === 0) {
    return {
      origin: 'unanswerable',
      detail: 'no reviewer process is running, so there is no group to belong to',
    };
  }

  const match = live.find((run) => isDescendantOf(process.pid, run.pid));
  if (match) {
    return {
      origin: 'inside',
      detail: `running under the ${match.role} process (pid ${match.pid})`,
    };
  }
  return {
    origin: 'outside',
    detail:
      `this call is not running under any live reviewer (we are pid ${process.pid}; ` +
      `running: ${live.map((r) => `${r.role}=${r.pid}`).join(', ')})`,
  };
}

// True when this run has a pid glafka can actually check. False for a run
// handed to an agent in your own session (markExternalRunStarted).
export function hasPidFile({
  stateDir,
  id,
  role = ROLES.CODER,
}: {
  stateDir: string;
  id: string;
  role?: string;
}): boolean {
  return fs.existsSync(runFiles(stateDir, id, role).pidPath);
}
