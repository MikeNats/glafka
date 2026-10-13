import { execFileSync } from 'node:child_process';

// Split out of process.ts only to keep that file under the line limit. These two answer the same
// question from opposite directions: everything BELOW a pid, and everything sharing its process
// GROUP — the two ways a run's own leftover process can still be found once the run itself is over.

// Every pid on the machine paired with its parent, in one call. `descendantPids` below needs the
// whole table anyway — one process at a time would be one `ps` call per process, and a wide tree
// makes that slow exactly when it matters most (killing something that spawned a lot).
function allParentPids(): Map<number, number> {
  const map = new Map<number, number>();
  if (process.platform === 'win32') return map;
  try {
    const out = execFileSync('ps', ['-eo', 'pid=,ppid='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    for (const line of out.split('\n')) {
      const [pidStr, ppidStr] = line.trim().split(/\s+/);
      const pid = Number(pidStr);
      const ppid = Number(ppidStr);
      if (Number.isInteger(pid) && Number.isInteger(ppid)) map.set(pid, ppid);
    }
  } catch {
    // Empty map. The caller treats that as "found nothing", which is safe: it
    // signals fewer processes, never more.
  }
  return map;
}

// Every live descendant of `pid`, at any depth. This is `signalTree`'s missing half: sending a
// signal to `-pid` reaches the process GROUP `spawnBackground` created, but a tool call the agent
// makes is free to start its own group — the exact thing proven of Claude Code's own Bash tool
// earlier tonight (a reviewer's pid and its Bash call's pgid were different numbers). A grandchild
// in a different group survives the group signal, keeps running, and holds no exit-code file — so
// `backgroundStatus` calls the run "finished" while an OS process from it is still alive.
export function descendantPids(pid: number): number[] {
  if (process.platform === 'win32') return [];
  const parents = allParentPids();
  const children = new Map<number, number[]>();
  for (const [child, parent] of parents) {
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent)!.push(child);
  }
  const out: number[] = [];
  const queue = [...(children.get(pid) ?? [])];
  while (queue.length > 0) {
    const next = queue.shift()!;
    out.push(next);
    queue.push(...(children.get(next) ?? []));
  }
  return out;
}

// Every live pid whose process GROUP is `pgid`. `spawnBackground` starts each run detached, making
// the run's own pid its group's leader, so `pgid` here is that original pid.
//
// This is for the run that has ALREADY exited by the time anyone looks — `backgroundStatus` only
// calls a run "finished" once its exit-code file exists, and by then the original pid is gone.
// `descendantPids` cannot help here: it walks the LIVE parent/child table, and the OS reparents an
// orphan the moment its parent exits, severing that link — asking "who are pid X's children" after
// X is dead always answers "nobody", correctly but uselessly. A process's GROUP, unlike its parent,
// does not change on reparenting, so this still finds a survivor that kept the run's original group.
// It will NOT find one that put itself in a group of its own before the parent exited — proven of
// Claude Code's own Bash tool earlier tonight — because that pid was never in this group to begin
// with. That narrower case needs a snapshot taken while the run is still alive; nothing observed
// after the fact can recover a link that reparenting already broke.
export function pidsInGroup(pgid: number): number[] {
  if (process.platform === 'win32') return [];
  try {
    const out = execFileSync('ps', ['-eo', 'pid=,pgid='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const out2: number[] = [];
    for (const line of out.split('\n')) {
      const [pidStr, pgidStr] = line.trim().split(/\s+/);
      const pid = Number(pidStr);
      const group = Number(pgidStr);
      if (Number.isInteger(pid) && group === pgid && pid !== pgid) out2.push(pid);
    }
    return out2;
  } catch {
    return [];
  }
}
