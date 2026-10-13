import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROLES } from '../types/ticket.js';
import { assertValidTicketId, TICKET_ID_RE } from './ids.js';
import { DOCS_ROOT } from '../memory/docsStore.js';
import { isPidAlive } from '../util/process.js';
import { DEFAULT_STALE_LOCK_MS, ownerIsGone } from '../util/fileOperations.js';

// Every path built from a ticket id lives here, and only here.
// Ids come from users, so each path checks the id first.

const WORKTREES_DIR = '.worktrees';

// --------------------------------------------------------------------------- A ticket's own state, under .glafka/

export function ticketsDir(stateDir: string): string {
  return path.join(stateDir, 'tickets');
}

export function closedTicketsDir(stateDir: string): string {
  return path.join(ticketsDir(stateDir), 'closed');
}

// One folder per ticket. Everything a ticket owns lives inside it, so
// closing is one move and nothing can be left behind.
export function ticketDir(dir: string, id: string): string {
  assertValidTicketId(id);
  return path.join(dir, id);
}

// A ticket's four files: its state, its history, its cost record, and the
// decisions taken while it ran. They always move together, one folder.
export function ticketFiles(
  dir: string,
  id: string,
): {
  dir: string;
  ticketFile: string;
  stagesFile: string;
  recordFile: string;
  decisionsFile: string;
} {
  const folder = ticketDir(dir, id);
  return {
    dir: folder,
    ticketFile: path.join(folder, 'ticket.json'),
    stagesFile: path.join(folder, 'stages'),
    // The audit record. Here, not under runs/, because runs/ is deleted on close.
    recordFile: path.join(folder, 'record.jsonl'),
    // What was decided while the ticket ran. Copied into git at close.
    decisionsFile: path.join(folder, 'decisions.md'),
  };
}

// The write lock on a ticket, deliberately OUTSIDE the ticket's folder.
// Inside, archiveClosedTicket would rename it while a holder still owned the
// old path, and a second process could take a fresh lock at the new one.
export function ticketLockPath(stateDir: string, id: string): string {
  assertValidTicketId(id);
  return path.join(ticketsDir(stateDir), `${id}.lock`);
}

// Setting up a ticket can take minutes before its folder exists. This lock
// marks that time, so nobody takes its ports or calls it abandoned.
// Outside the folder for the same reason the write lock is.
export function provisioningLockPath(stateDir: string, id: string): string {
  assertValidTicketId(id);
  return path.join(ticketsDir(stateDir), `${id}.provisioning`);
}

// One lock, shared by every ticket being provisioned at once. Port probing (bind, check free, release) and the durable claim that follows it are
export function portsLockPath(stateDir: string): string {
  return path.join(stateDir, 'ports.lock');
}

// The branch is written first, and the ports are added later once picked.
// The process id and time tell us apart "still running" from "died".
export function writeProvisioningLock(
  stateDir: string,
  id: string,
  {
    branch,
    ports = [],
    pid = process.pid,
    startedAt = Date.now(),
  }: { branch: string; ports?: number[]; pid?: number; startedAt?: number },
): string {
  const lockPath = provisioningLockPath(stateDir, id);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({ branch, ports, pid, startedAt }));
  return lockPath;
}

export function removeProvisioningLock(stateDir: string, id: string): void {
  fs.rmSync(provisioningLockPath(stateDir, id), { force: true });
}

// A copy of the value in config.js. We copy instead of import,
// because this file is meant to have no dependencies.
const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 15 * 60 * 1000;

// A lock is old once its process is gone, or it ran past the time limit.
// With no process id or start time we can not judge, so we never guess.
export function isStaleProvisioningLock(
  { pid, startedAt }: { pid: number | null; startedAt: number | null },
  { bootstrapTimeoutMs = DEFAULT_BOOTSTRAP_TIMEOUT_MS }: { bootstrapTimeoutMs?: number } = {},
): boolean {
  if (pid == null || startedAt == null) return false;
  if (!isPidAlive(pid)) return true;
  return Date.now() - startedAt > bootstrapTimeoutMs;
}

export interface ProvisioningEntry {
  id: string;
  branch: string | null;
  ports: number[];
  pid: number | null;
  startedAt: number | null;
  lockPath: string;
}

// Every ticket still being set up, read from the lock files above.
// A half-written lock still gets an entry, with empty fields, not an error.
export function listProvisioning(stateDir: string): ProvisioningEntry[] {
  const dir = ticketsDir(stateDir);
  if (!fs.existsSync(dir)) return [];
  const entries: ProvisioningEntry[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.provisioning')) continue;
    const id = name.slice(0, -'.provisioning'.length);
    if (!TICKET_ID_RE.test(id)) continue;
    const lockPath = path.join(dir, name);
    let branch: string | null = null;
    let ports: number[] = [];
    let pid: number | null = null;
    let startedAt: number | null = null;
    try {
      ({
        branch = null,
        ports = [],
        pid = null,
        startedAt = null,
      } = JSON.parse(fs.readFileSync(lockPath, 'utf8')));
    } catch {
      // Ignore it and keep the empty values from above.
    }
    entries.push({ id, branch, ports, pid, startedAt, lockPath });
  }
  return entries;
}

// --------------------------------------------------------------------------- The write lock on a ticket's JSON file. Listed here so cleanup can

// May cleanup delete this write lock? Same question withFileLock asks before
// stealing one: a merely OLD lock still belongs to a live, working process.
export function isStaleFileLock(
  entry: {
    pid: number | null;
    startedAt: number | null;
    startProof?: number | null;
    proofUnavailable?: boolean;
  },
  { staleLockMs = DEFAULT_STALE_LOCK_MS }: { staleLockMs?: number } = {},
): boolean {
  return ownerIsGone(entry, staleLockMs);
}

export interface FileLockEntry {
  id: string;
  pid: number | null;
  startedAt: number | null;
  // Absent on locks written by an older glafka. See ownerIsGone.
  startProof: number | null;
  // Set when THIS version wrote the lock and the host could not prove the start time. Must be carried
  // through, or ownerIsGone reads the lock as a legacy one and judges a live holder by the clock.
  proofUnavailable: boolean;
  // The file said nothing we could read, so no owner can be identified. Not stealable by ownerIsGone —
  // which is exactly why it has to be REPORTABLE, or it blocks the ticket for good.
  corrupt: boolean;
  lockPath: string;
}

export function listFileLocks(stateDir: string): FileLockEntry[] {
  const dir = ticketsDir(stateDir);
  if (!fs.existsSync(dir)) return [];
  const entries: FileLockEntry[] = [];
  for (const name of fs.readdirSync(dir)) {
    // Must match what ticketLockPath writes. It used to be `<id>.json.lock`,
    // beside a flat ticket file; a scan left on the old suffix returns []
    // and reads as "no locks", which is the worst lie this file can tell.
    if (!name.endsWith('.lock')) continue;
    const id = name.slice(0, -'.lock'.length);
    if (!TICKET_ID_RE.test(id)) continue;
    const lockPath = path.join(dir, name);
    let pid: number | null = null;
    let startedAt: number | null = null;
    let startProof: number | null = null;
    let proofUnavailable = false;
    let corrupt = false;
    try {
      ({
        pid = null,
        startedAt = null,
        startProof = null,
        proofUnavailable = false,
      } = JSON.parse(fs.readFileSync(lockPath, 'utf8')));
    } catch {
      // Empty or unreadable. Keep the empty values above and say so, rather
      // than leaving it to look like an ordinary lock nobody may touch.
      corrupt = true;
    }
    if (pid == null) corrupt = true;
    entries.push({ id, pid, startedAt, startProof, proofUnavailable, corrupt, lockPath });
  }
  return entries;
}

// --------------------------------------------------------------------------- A background run's scratch files, under .glafka/tickets/<id>/runs/<role>/

// One folder per role, each holding that run's prompt and its whole log, which
// readTail says reaches megabytes. archiveClosedTicket removes it on close.
export function runsDir(stateDir: string, id: string): string {
  return path.join(ticketDir(ticketsDir(stateDir), id), 'runs');
}

// `role` gives each kind of run its own folder, so a coder and a reviewer
// on the same ticket never clash. It defaults to "coder".
export function runFiles(stateDir: string, id: string, role: string = ROLES.CODER) {
  const dir = path.join(runsDir(stateDir, id), role);
  return {
    dir,
    pidPath: path.join(dir, 'pid'),
    logPath: path.join(dir, 'log'),
    exitCodePath: path.join(dir, 'exit-code'),
    // Says the exit code beside it was assumed by glafka, not read off a
    // process. The audit records "not measured" instead of a made-up 0.
    assumedExitPath: path.join(dir, 'assumed-exit-code'),
    promptPath: path.join(dir, 'prompt'),
    // Which agent ran. The finish side is a different process and cannot
    // see the command that started this.
    agentPath: path.join(dir, 'agent'),
    startedAtPath: path.join(dir, 'started-at'),
    recordedPath: path.join(dir, 'recorded'),
    // Guards the check-then-spawn sequence itself, not the run's own files —
    // see ergonBackground/dispatchReviewer.
    lockPath: path.join(dir, 'spawn.lock'),
    // The OS's own record of when the spawned pid started, so a later check can tell our process apart from an unrelated one that has
    startProofPath: path.join(dir, 'start-proof'),
    // Written by killBackground before it signals. A killed run writes no exit
    // code, so without this it is indistinguishable from a real crash.
    killedPath: path.join(dir, 'killed'),
    // Marks that the orphan sweep has already run for this finished run. Its own file, separate from
    // `recordedPath`: that one is gated on `observability` (an audit-trail setting), and a leftover
    // OS process is not an audit concern — it needs sweeping once whether or not audit logging is on.
    reapedPath: path.join(dir, 'reaped'),
  };
}

// Every role that has ever started a run for this ticket, read off the disk rather than off the
// ticket file. The ticket's own `reviewerRoles` is written by the code that dispatches, so it is
// only right when that write happened and landed. A role that is running and NOT on the list is
// invisible to every liveness guard. The directory,
// by contrast, exists because a run actually created it. Belt-and-braces: the guards union the two.
export function runRolesOnDisk(stateDir: string, id: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(runsDir(stateDir, id), { withFileTypes: true });
  } catch {
    // No runs folder means no run ever started. Not an error.
    return [];
  }
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

// --------------------------------------------------------------------------- The worktree checkout, at the top level of the repo

export function worktreesRoot(repoRoot: string): string {
  return path.join(repoRoot, WORKTREES_DIR);
}

export function worktreePath(repoRoot: string, id: string): string {
  assertValidTicketId(id);
  return path.join(worktreesRoot(repoRoot), id);
}

// The agent's TMPDIR for this ticket, outside the repo. spawnBackground makes
// it, releaseResources removes it; both call this, so they cannot drift.
export function ticketScratchPath(id: string): string {
  assertValidTicketId(id);
  return path.join(os.tmpdir(), `glafka-${id}`);
}

// A softer check for paths we found by reading .worktrees.
// It only stops a path that points outside that folder.
export function assertUnderWorktreesRoot(repoRoot: string, candidate: string): string {
  const resolved = path.resolve(candidate);
  if (path.dirname(resolved) !== path.resolve(worktreesRoot(repoRoot))) {
    throw new Error(
      `refusing to delete ${JSON.stringify(candidate)}: not inside ` + `${worktreesRoot(repoRoot)}`,
    );
  }
  return resolved;
}

// Stops us deleting anything that is not a real ticket folder.
// Without it, a bad ticket file could delete a home folder.
export function assertIsTicketWorktree(candidate: string): string {
  const resolved = path.resolve(candidate);
  const name = path.basename(resolved);
  const parent = path.basename(path.dirname(resolved));

  if (!TICKET_ID_RE.test(name) || parent !== WORKTREES_DIR) {
    throw new Error(
      `refusing to delete ${JSON.stringify(candidate)}: not a ticket worktree ` +
        `(expected <something>/${WORKTREES_DIR}/<ticket-id>). ` +
        `This means the ticket's stored worktree path is wrong — fix or delete the ticket file.`,
    );
  }
  return resolved;
}

// --------------------------------------------------------------------------- Permanent, git-tracked docs, under docs/glafka/

// One folder per ticket here too, named for the id, so the same name is one
// folder in both trees. Kept in git forever, for people to read.
export function ticketDocsDir(repoRoot: string, id: string): string {
  assertValidTicketId(id);
  return path.join(repoRoot, DOCS_ROOT, 'tickets', id);
}

export function specPath(repoRoot: string, id: string): string {
  return path.join(ticketDocsDir(repoRoot, id), 'spec.md');
}

export function planPath(repoRoot: string, id: string): string {
  return path.join(ticketDocsDir(repoRoot, id), 'plan.md');
}

// The permanent copy of a ticket's cost record. Written ONCE, by lysis or
// cancel, at close. Never appended to: rows land in .glafka/ while the ticket
// lives, or every run would dirty the main checkout under a working agent.
export function auditPath(repoRoot: string, id: string): string {
  return path.join(ticketDocsDir(repoRoot, id), 'audit.jsonl');
}

// The permanent copy of what was decided. Written ONCE, at close, for the same
// reason auditPath is: appending here would dirty main under a working agent.
export function decisionsDocPath(repoRoot: string, id: string): string {
  return path.join(ticketDocsDir(repoRoot, id), 'decisions.md');
}

// Where specs and plans lived before one folder per ticket. Nothing writes
// here any more — ticketIdTaken reads it so an old spec still holds its name
// in a repo that has them, rather than a new ticket quietly reusing it.
function legacyDocPaths(repoRoot: string, id: string): string[] {
  return [
    path.join(repoRoot, DOCS_ROOT, 'specs', `${id}.md`),
    path.join(repoRoot, DOCS_ROOT, 'plans', `${id}.md`),
  ];
}

// --------------------------------------------------------------------------- Is this name free?

// What already holds this name, or null. A closed ticket still holds one: its
// docs and its branch are permanent, so reusing the name would collide there.
export function ticketIdTaken({
  stateDir,
  repoRoot,
  id,
}: {
  stateDir: string;
  repoRoot: string;
  id: string;
}): string | null {
  const candidates: [string, string][] = [
    ['an open ticket', ticketFiles(ticketsDir(stateDir), id).ticketFile],
    ['a closed ticket', ticketFiles(closedTicketsDir(stateDir), id).ticketFile],
    ['a worktree', path.join(worktreesRoot(repoRoot), id)],
    ['a spec', specPath(repoRoot, id)],
    ...legacyDocPaths(repoRoot, id).map((candidate): [string, string] => [
      'a spec from an older glafka',
      candidate,
    ]),
  ];
  for (const [what, candidate] of candidates) {
    if (fs.existsSync(candidate)) return what;
  }
  return null;
}
