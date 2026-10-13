import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isPidAlive, processStartTimeMs, sameProcessStart } from './process.js';

// A held lock, handed to the work that runs under it. `assertHeld` is the safety half of the lease
// (see withFileLock): it is what a writer calls in the last moment before its destructive step, so
// a holder whose lease has already been taken over refuses to write instead of writing second.
// Without it, "did the reclaimer judge correctly" would be the only thing standing between two
// writers.
export interface Lease {
  assertHeld(): void;
  // Milliseconds until this lease runs out. Negative means it already has.
  remainingMs(): number;
}

// Write to a temp file, then rename it. Renaming happens in one step, so a crash can never leave
// half a file. With a lease, the check happens immediately before the rename — the last instruction
// before the file changes — so the window between "still ours" and "written" is as small as this
// can be made without an OS lock.
export function writeFile(filePath: string, content: string, lease?: Lease | null): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // Named by pid alone, deterministically. Writes to one file are serialised by the lock above it, and
  // test/memory/ethos.test.ts injects a failed write by pre-creating this exact path — a random suffix would silently stop that test from testing anything.
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, content, 'utf8');
  try {
    lease?.assertHeld();
  } catch (err) {
    // Our write is not going to land, so it must not leave litter behind.
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Nothing to clean up, or already gone.
    }
    throw err;
  }
  fs.renameSync(tmpPath, filePath);
}

// A real wait that blocks, unlike a promise-based delay. We need it while
// another process holds a lock, and where a signal handler cannot await.
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Only used for locks written by an older glafka, which carry no start-time
// proof. See ownerIsGone below for why time alone is not enough.
export const DEFAULT_STALE_LOCK_MS = 60 * 1000;

// Our own start time cannot change, and asking the OS costs a subprocess.
// Locks are taken on every ticket write, so we ask once and keep it.
let ownStartProof: number | null | undefined;
function ourStartProof(): number | null {
  if (ownStartProof === undefined) ownStartProof = processStartTimeMs(process.pid);
  return ownStartProof;
}

// What goes inside a lock file. `startProof` tells a live owner apart from a recycled pid; `nonce`
// keeps two locks from one process distinguishable. `proofUnavailable` says WHY startProof is
// missing, and the two reasons need opposite answers. A lock written by an older glafka has no
// startProof because the field did not exist, and the clock is genuinely all there is. A lock
// written by THIS version has none because the host could not answer — and falling back to the
// clock there is not a legacy allowance, it is every lock on that host silently reverting to the
// rule start-proof was added to replace. How long a taken lock is good for. A holder that goes past
// this has its lock taken over, and — this is the half that makes it safe — refuses its own write
// when it next checks. Long enough that no honest critical section reaches it: the work under these
// locks is a read-modify-write of one small JSON file.
export const DEFAULT_LEASE_MS = 30 * 1000;

export function lockBody(leaseMs: number = DEFAULT_LEASE_MS): string {
  const startProof = ourStartProof();
  const now = Date.now();
  return JSON.stringify({
    pid: process.pid,
    startedAt: now,
    startProof,
    ...(startProof == null ? { proofUnavailable: true } : {}),
    // When this holder's claim runs out. A waiter needs no `ps` and no judgement call to read this:
    // either the clock is past it or it is not.
    leaseUntil: now + leaseMs,
    nonce: crypto.randomBytes(8).toString('hex'),
  });
}

// Is the holder really GONE? Age used to be enough, which let a second writer
// delete a live holder's lock and enter beside it. Ask the owner, not the clock.
export function ownerIsGone(
  {
    pid,
    startedAt,
    startProof,
    proofUnavailable,
  }: {
    pid?: number | null;
    startedAt?: number | null;
    startProof?: number | null;
    proofUnavailable?: boolean;
  },
  staleLockMs: number = DEFAULT_STALE_LOCK_MS,
): boolean {
  // Nothing to judge by. Never guess a live owner is dead.
  if (pid == null || startedAt == null) return false;
  if (!isPidAlive(pid)) return true;

  // Alive — but is it still the SAME process, or was the pid recycled?
  // That reuse case is the only thing the old timeout genuinely caught.
  if (startProof != null) {
    const current = processStartTimeMs(pid);
    // We cannot prove it right now (ps hiccuped). Treat the owner as alive:
    // a hung holder gets reported to you, a stolen lock corrupts state.
    if (current == null) return false;
    return !sameProcessStart(startProof, current);
  }

  // This version wrote the lock and the host could not answer. Same call as the `current == null`
  // branch above, so it gets the same answer: the owner is alive. A hung holder gets reported to you; a stolen lock corrupts state.
  if (proofUnavailable) return false;

  // Written by an older glafka, so the clock is all we have. Kept only
  // so an upgrade does not leave those locks stuck forever.
  return Date.now() - startedAt > staleLockMs;
}

// Takes the lock atomically: write a private file, then link it onto the lock path. `link`
// publishes a COMPLETE file or nothing, and fails with EEXIST if the lock is held — so a crash
// between the two can never leave a half-written lock that no later reader can identify an owner
// from. `writeFile` above already uses the same shape for the same reason.
function takeLock(lockPath: string, body: string): void {
  const staging = `${lockPath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(staging, body);
  try {
    fs.linkSync(staging, lockPath);
  } finally {
    try {
      fs.unlinkSync(staging);
    } catch {
      // The link succeeded or it did not; either way this copy is not wanted.
    }
  }
}

// What a lock file says, or null when it says nothing we can read.
export function readLock(lockPath: string): {
  pid?: number | null;
  startedAt?: number | null;
  startProof?: number | null;
  proofUnavailable?: boolean;
} | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

// May we clear this lock? Returns the exact bytes we judged, so the caller can delete only the file
// it actually looked at. Judging and deleting used to be two unguarded reads, and the ~10ms `ps`
// call sits between them — long enough for the holder to release and a new one to take it.
function staleLockBytes(lockPath: string, staleLockMs: number): string | null {
  let judged: string;
  try {
    judged = fs.readFileSync(lockPath, 'utf8');
  } catch {
    return null;
  }
  const owner = readLock(lockPath);
  if (owner === null) {
    // Names nobody. The "never guess a live owner is dead" rule exists to protect a lock that names a
    // live process; this one names nothing, so age is the only story left and it is a legitimate one.
    return Date.now() - fileAgeStart(lockPath) > staleLockMs ? judged : null;
  }
  return ownerIsGone(owner, staleLockMs) ? judged : null;
}

function fileAgeStart(lockPath: string): number {
  try {
    return fs.statSync(lockPath).mtimeMs;
  } catch {
    return Date.now();
  }
}

// Deletes the lock only if it still holds the bytes we judged.
function clearJudgedLock(lockPath: string, judged: string): void {
  try {
    if (fs.readFileSync(lockPath, 'utf8') === judged) fs.unlinkSync(lockPath);
  } catch {
    // Gone, or now someone else's. Either way, not ours to remove.
  }
}

// --------------------------------------------------------------------------- The lease

// When did this lock's claim run out? Null when it does not say — a lock
// written by an older glafka, which the age rules below still handle.
function leaseUntilOf(lockPath: string): number | null {
  const owner = readLock(lockPath) as { leaseUntil?: unknown } | null;
  return typeof owner?.leaseUntil === 'number' ? owner.leaseUntil : null;
}

// Has this lock's lease run out? A pure clock comparison, which is the point: the old question —
// "is the holder really gone?" — needed `ps`, took ~10ms, and could be answered wrongly. This one
// cannot be answered wrongly, because the holder is bound by the SAME number and refuses to write
// once it passes (see makeLease below).
function leaseExpired(lockPath: string): boolean {
  const until = leaseUntilOf(lockPath);
  if (until === null) return false;
  return Date.now() > until;
}

// The handle the work under a lock gets. `assertHeld` is the safety property. Takeover is decided
// by a clock both sides can read, so a holder that has been taken over can always tell — and must
// refuse rather than write second. This is what makes takeover safe without an OS lock: correctness
// does not depend on the reclaimer being right about whether we died, only on both of us reading
// the same deadline.
function makeLease(lockPath: string, ours: string, leaseUntil: number): Lease {
  return {
    remainingMs: () => leaseUntil - Date.now(),
    assertHeld() {
      if (Date.now() > leaseUntil) {
        throw Object.assign(
          new Error(
            `refusing to write: this process held ${lockPath} but its lease ran out ` +
              `${Date.now() - leaseUntil}ms ago, so another writer may already have taken it ` +
              `over. Nothing was written. Retry the operation.`,
          ),
          { code: 'ELEASEEXPIRED' },
        );
      }
      // Still inside our window, but has someone replaced the file anyway?
      // Cheap, and it catches a lock cleared by hand.
      let current: string;
      try {
        current = fs.readFileSync(lockPath, 'utf8');
      } catch {
        throw Object.assign(
          new Error(
            `refusing to write: this process held ${lockPath} and it is gone — ` +
              `it was removed by hand or by a sweep. Nothing was written. Retry the operation.`,
          ),
          { code: 'ELOCKLOST' },
        );
      }
      if (current !== ours) {
        throw Object.assign(
          new Error(
            `refusing to write: ${lockPath} is now held by someone else. ` +
              `Nothing was written. Retry the operation.`,
          ),
          { code: 'ELOCKLOST' },
        );
      }
    },
  };
}

// Stops two processes writing one file at the same time. Creating the lock fails if it already exists, so only one process can win. We then wait.
export function withFileLock<T>(
  lockPath: string,
  fn: (lease: Lease) => T,
  {
    retries = 100,
    delayMs = 20,
    staleLockMs = DEFAULT_STALE_LOCK_MS,
    leaseMs = DEFAULT_LEASE_MS,
  }: { retries?: number; delayMs?: number; staleLockMs?: number; leaseMs?: number } = {},
): T {
  // The exact text we wrote. Reading it back instead would race with anyone
  // who replaced the file between our write and that read.
  let ours = '';
  let leaseUntil = 0;
  for (let attempt = 0; ; attempt++) {
    try {
      leaseUntil = Date.now() + leaseMs;
      ours = lockBody(leaseMs);
      takeLock(lockPath, ours);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const judged = reclaimableBytes(lockPath, staleLockMs);
      if (judged !== null) {
        // Delete only the bytes we judged, never "whatever is there now".
        clearJudgedLock(lockPath, judged);
        continue;
      }
      if (attempt >= retries) {
        throw Object.assign(
          new Error(
            `${lockPath} is still locked after ${retries} retries (~${retries * delayMs}ms) — ` +
              `its holder's lease has not run out yet, so \`glafka lysis --sweep\` will not ` +
              `clear it either. If you're sure no glafka process is using it, delete that file ` +
              `and try again`,
          ),
          { code: 'EEXIST' },
        );
      }
      sleepSync(delayMs);
    }
  }
  try {
    return fn(makeLease(lockPath, ours, leaseUntil));
  } finally {
    // Only remove it if it is still the one we wrote. A lock whose lease ran
    // out can be taken over by someone else while we are in here.
    try {
      if (fs.readFileSync(lockPath, 'utf8') === ours) fs.unlinkSync(lockPath);
    } catch {
      // Gone, or now someone else's. Either way, not ours to remove.
    }
  }
}

// May this lock be taken over, and if so which exact bytes did we judge? TWO independent reasons,
// and both are needed: 1. The lease ran out. A clock comparison the reclaimer cannot get wrong,
// because the holder is bound by the same deadline and refuses its own write once it passes.
// This is what makes takeover safe without an OS lock. 2. The owner is provably
// gone — dead pid, or a recycled one. A dead holder is never going to write, so waiting out its
// lease would only wedge the ticket for 30 seconds for no gain. This is the pre-lease rule, kept.
// Returning the bytes, not a boolean, is what lets the caller delete only the file it actually
// looked at rather than "whatever is there now".
function reclaimableBytes(lockPath: string, staleLockMs: number): string | null {
  // Read once, up front: this is the copy every judgement below is about.
  let judged: string;
  try {
    judged = fs.readFileSync(lockPath, 'utf8');
  } catch {
    return null;
  }
  if (leaseExpired(lockPath)) return judged;
  return staleLockBytes(lockPath, staleLockMs);
}

function sleepAsync(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Same guarantee as withFileLock, for work that has to await — port probing binds and releases real sockets one at a time, which needs the event
export async function withFileLockAsync<T>(
  lockPath: string,
  fn: (lease: Lease) => Promise<T>,
  {
    retries = 100,
    delayMs = 20,
    staleLockMs = DEFAULT_STALE_LOCK_MS,
    // Longer than the sync default: this variant exists for port probing, which binds and releases real
    // sockets one at a time and is genuinely slower than a JSON read-modify-write.
    leaseMs = DEFAULT_LEASE_MS * 2,
  }: { retries?: number; delayMs?: number; staleLockMs?: number; leaseMs?: number } = {},
): Promise<T> {
  // Same as withFileLock above: keep the text we wrote, do not re-read it.
  let ours = '';
  let leaseUntil = 0;
  for (let attempt = 0; ; attempt++) {
    try {
      leaseUntil = Date.now() + leaseMs;
      ours = lockBody(leaseMs);
      takeLock(lockPath, ours);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const judged = reclaimableBytes(lockPath, staleLockMs);
      if (judged !== null) {
        clearJudgedLock(lockPath, judged);
        continue;
      }
      if (attempt >= retries) {
        throw Object.assign(
          new Error(
            `${lockPath} is still locked after ${retries} retries (~${retries * delayMs}ms) — ` +
              `its holder's lease has not run out yet, so \`glafka lysis --sweep\` will not ` +
              `clear it either. If you're sure no glafka process is using it, delete that file ` +
              `and try again`,
          ),
          { code: 'EEXIST' },
        );
      }
      await sleepAsync(delayMs);
    }
  }
  try {
    return await fn(makeLease(lockPath, ours, leaseUntil));
  } finally {
    try {
      if (fs.readFileSync(lockPath, 'utf8') === ours) fs.unlinkSync(lockPath);
    } catch {
      // Gone, or now someone else's. Either way, not ours to remove.
    }
  }
}

// Turns a flat list of paths into an indented tree.
// Empty folders never show up, because git does not report them.

// Git always uses "/", even on Windows.
const GIT_SEPARATOR = '/';

type TreeNode = Map<string, TreeNode | null>;

// A name points to a Map for a folder, or null for a file.
// We use a Map so a name like "__proto__" is not special.
function nest(paths: string[]): TreeNode {
  const root: TreeNode = new Map();
  for (const filePath of paths) {
    const parts = filePath.split(GIT_SEPARATOR).filter(Boolean);
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (i === parts.length - 1) {
        node.set(part, null);
        break;
      }
      if (!(node.get(part) instanceof Map)) node.set(part, new Map());
      node = node.get(part) as TreeNode;
    }
  }
  return root;
}

function render(node: TreeNode, indent: string): string {
  return [...node.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      // The name came from the map's own keys, so it is always there.
      const child = node.get(name) ?? null;
      if (child === null) return `${indent}${name}`;
      return `${indent}${name}/\n${render(child, indent + '  ')}`;
    })
    .join('\n');
}

export function formatFileTree(paths: string[]): string {
  return render(nest(paths), '');
}
