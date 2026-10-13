import { execFileSync } from 'node:child_process';

// Split out of process.ts only to keep that file under the line limit.

// How far up the parent chain we are willing to walk. A real agent sits three or four processes
// below its run — wrapper, shell, node — and anything much deeper than this is a runaway loop, not
// an ancestry.
const MAX_ANCESTRY_DEPTH = 40;

// Walks `pid` up through its parents and says whether `ancestor` is one of them. This replaced a
// process-group comparison, which assumed a run's descendants keep the run's pgid. `spawnBackground`
// does start each run detached, so the run IS its group leader — but an agent runner is free to put
// its own tool calls in a fresh group, and a real one does: a reviewer spawned as pid 21014 answered
// from a Bash call whose pgid was 21713. The group test therefore said "outside" for the one caller
// it was written to say "inside" about, and every clean verdict a reviewer recorded was silently
// downgraded to unverified no matter how correct its token. Ancestry survives re-grouping and still
// refuses the case the check exists for: a coder, or a person's own shell, replaying a copied token
// is not a descendant of the reviewer.
export function isDescendantOf(pid: number, ancestor: number): boolean {
  if (process.platform === 'win32') return false;
  // pid 1 is the ancestor of EVERY process on the machine, and pid 0 is not a process at all.
  // Without this line a run whose pid file held either would answer "inside" to any caller alive,
  // which is the exact opposite of what this check is for. No real agent run is ever pid 1.
  if (ancestor <= 1) return false;
  let current = pid;
  for (let depth = 0; depth < MAX_ANCESTRY_DEPTH; depth++) {
    if (current === ancestor) return true;
    // pid 1 has no parent worth following, and 0 means we ran out.
    if (current <= 1) return false;
    const parent = parentPid(current);
    if (parent == null) return false;
    current = parent;
  }
  return false;
}

export function parentPid(pid: number): number | null {
  if (process.platform === 'win32') return null;
  try {
    const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const ppid = Number(out.trim());
    return Number.isInteger(ppid) && ppid >= 0 ? ppid : null;
  } catch {
    return null;
  }
}
