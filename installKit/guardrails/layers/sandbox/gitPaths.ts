import fs from 'node:fs';
import path from 'node:path';

// Every submodule keeps its own git dir under .git/modules, whose hooks and
// config run on the host just like the top-level ones the deny already covers.
export function submoduleGitPaths(commonGitDir: string): { hooks: string[]; configs: string[] } {
  const hooks: string[] = [];
  const configs: string[] = [];

  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      // Not there, or not readable. Nothing to protect.
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // No need to look inside a hooks folder: the whole thing is denied.
        if (entry.name === 'hooks') hooks.push(full);
        else walk(full);
      } else if (entry.isFile() && entry.name === 'config') {
        configs.push(full);
      }
    }
  };

  walk(path.join(commonGitDir, 'modules'));
  return { hooks, configs };
}

// A worktree's ".git" is a FILE naming its real git dir. We read it rather
// than guess the name, because git adds a suffix when two of them collide.
export function ownWorktreeGitDir(worktree: string): string | null {
  try {
    const gitPath = path.join(worktree, '.git');
    // A folder means this is the main checkout, which has no entry there.
    if (fs.statSync(gitPath).isDirectory()) return null;
    const line = fs.readFileSync(gitPath, 'utf8').trim();
    return path.resolve(worktree, line.replace(/^gitdir:\s*/, ''));
  } catch {
    return null;
  }
}

// The files that tell git where the repo is. Host git follows them after the
// cage, so a changed one would run agent code uncaged. Both cages keep them read-only.
export function worktreePointerFiles(worktree: string, worktreeGitDir: string): string[] {
  return [
    path.join(worktree, '.git'),
    path.join(worktreeGitDir, 'commondir'),
    path.join(worktreeGitDir, 'gitdir'),
    path.join(worktreeGitDir, 'config.worktree'),
  ];
}

// The ref this worktree is standing on, e.g. "refs/heads/glafka/t-abcd1234". Read from the
// worktree's own HEAD, which is git's record rather than ours. Null on a detached HEAD, and null is
// load-bearing: without a branch to give back, narrowing the shared refs would stop the coder
// committing at all, so the caller keeps the old wide allowance and says so.
export function ownBranchRef(worktreeGitDir: string | null): string | null {
  if (!worktreeGitDir) return null;
  try {
    const head = fs.readFileSync(path.join(worktreeGitDir, 'HEAD'), 'utf8').trim();
    const match = /^ref:\s*(refs\/heads\/.+)$/.exec(head);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

// What a commit from a worktree really writes in the SHARED git folder. Measured, not assumed:
// `objects/`, this branch's own ref, this branch's own reflog, and the worktree's own metadata
// folder. Nothing else. `HEAD`, `index`, `packed-refs`, `logs/HEAD`, `info/` and every OTHER
// branch's ref are untouched by committing — which is what makes narrowing them safe. `refs/stash`
// is here because level 4 allows `git stash`, and stash writes a shared ref. Leaving it out shuts
// the doorman's own allow-list off at the knees, which is the failure mode this narrowing has to
// avoid.
export function sharedGitWriteAllowances(commonGitDir: string, branchRef: string): string[] {
  const paths = [
    path.join(commonGitDir, branchRef),
    path.join(commonGitDir, 'logs', branchRef),
    path.join(commonGitDir, 'refs', 'stash'),
    path.join(commonGitDir, 'logs', 'refs', 'stash'),
  ];
  // Git writes `<ref>.lock` first and renames it into place, so the lock needs
  // the same permission as the ref itself or every update fails.
  return paths.flatMap((p) => [p, `${p}.lock`]);
}
