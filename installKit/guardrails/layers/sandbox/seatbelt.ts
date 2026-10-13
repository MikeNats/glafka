import path from 'node:path';
import { sharedGitWriteAllowances, worktreePointerFiles } from './gitPaths.js';

// The macOS Seatbelt rules. The last rule that matches wins.
// Prefer docker when you can, because it does not need this trade-off.
export function seatbeltProfile({
  worktree,
  scratch,
  home,
  commonGitDir,
  allowNetwork,
  submodule = { hooks: [], configs: [] },
  worktreeGitDir = null,
  branchRef = null,
}: {
  worktree: string;
  scratch: string;
  home: string;
  commonGitDir: string;
  allowNetwork: boolean;
  submodule?: { hooks: string[]; configs: string[] };
  worktreeGitDir?: string | null;
  branchRef?: string | null;
}): string {
  // With a branch to give back, the shared git folder is narrowed to what committing actually
  // needs. Without one (a detached HEAD), narrowing would leave nothing writable to commit to, so
  // the old wide allowance stays and `describe` says so rather than a coder discovering it.
  const narrowedGit = branchRef
    ? `
; The shared git folder is writable above, because committing from a worktree
; writes objects and the shared ref. That is far more than committing needs:
; it also handed over every OTHER branch, HEAD, the index, the reflog and
; packed-refs — i.e. everything that HOLDS your work, while only the paths
; that RUN code were shut. Measured against a real commit,
; these are untouched by any of it.
(deny file-write* (subpath "${commonGitDir}/refs"))
(deny file-write* (subpath "${commonGitDir}/logs"))
(deny file-write* (subpath "${commonGitDir}/info"))
(deny file-write* (literal "${commonGitDir}/HEAD"))
(deny file-write* (literal "${commonGitDir}/index"))
(deny file-write* (literal "${commonGitDir}/packed-refs"))

; Given back: this ticket's own branch ref and reflog, and the stash, which
; level 4 allows as a command and which writes a shared ref.
(allow file-write*
${sharedGitWriteAllowances(commonGitDir, branchRef)
  .map((p) => `  (literal "${p}")`)
  .join('\n')})
`
    : `
; NOT narrowed: this worktree is on a detached HEAD, so there is no branch ref
; to give back and narrowing would stop it committing at all. The whole shared
; git folder stays writable here.
`;
  return `(version 1)
(deny default)

; A process needs these to exist at all.
(allow process* sysctl* mach*)

; The usual device files. Without these, nothing prints.
(allow file-read* file-write*
  (literal "/dev/null")
  (literal "/dev/zero")
  (literal "/dev/random")
  (literal "/dev/urandom")
  (literal "/dev/stdin")
  (literal "/dev/stdout")
  (literal "/dev/stderr")
  (literal "/dev/tty"))

; READ, in four steps. Order matters — the last match wins.
;   1. the toolchain needs a wide read just to start
(allow file-read*)
;   2. take the whole home folder back
(deny file-read* (subpath "${home}"))
;   3. let it see that files exist under home, but never read them.
;      git needs this to find its own repo folder.
(allow file-read-metadata (subpath "${home}"))
;   4. give back real reads: this ticket's folders, the shared git folder,
;      and the two global git config files that git dies without.
(allow file-read*
  (subpath "${worktree}")
  (subpath "${scratch}")
  (subpath "${commonGitDir}")
  (literal "${path.join(home, '.gitconfig')}")
  (literal "${path.join(home, '.config', 'git', 'config')}"))

; WRITE: the same three. Committing writes into the shared git folder too,
; not only inside the worktree.
(allow file-write*
  (subpath "${worktree}")
  (subpath "${scratch}")
  (subpath "${commonGitDir}"))

; But not hooks. Git only reads them, and they are shared with your own
; checkout, so an agent must never plant one there.
(deny file-write* (subpath "${commonGitDir}/hooks"))

; Same for config. A key written there runs agent code on your next
; ordinary git command. Git does not need to write config to commit.
(deny file-write* (literal "${commonGitDir}/config"))
(deny file-write* (literal "${commonGitDir}/config.worktree"))
${narrowedGit}

; Every submodule has its own git dir under .git/modules, with its own hooks
; and config. They run on the host just the same, so they get the same deny.
${submodule.hooks.map((dir) => `(deny file-write* (subpath "${dir}"))`).join('\n') || '; (no submodules)'}
${submodule.configs.map((file) => `(deny file-write* (literal "${file}"))`).join('\n')}

; Other tickets' git metadata lives beside ours under .git/worktrees. One
; coder must not touch another's, so we deny them all and give back our own.
(deny file-write* (subpath "${commonGitDir}/worktrees"))
${worktreeGitDir ? `(allow file-write* (subpath "${worktreeGitDir}"))` : '; (no worktree git dir of our own)'}

; But not the files that say where the repo is. Host git follows them later.
${
  worktreeGitDir
    ? worktreePointerFiles(worktree, worktreeGitDir)
        .map((file) => `(deny file-write* (literal "${file}"))`)
        .join('\n')
    : '; (no pointer files: this is the main checkout)'
}

${allowNetwork ? '; network left open at this level\n(allow network*)' : '; no network at all — this is what makes the read deny-list survivable\n(deny network*)'}
`;
}
