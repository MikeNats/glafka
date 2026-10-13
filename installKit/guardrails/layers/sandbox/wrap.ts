import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findRepoRoot } from '../../core.js';
import type { Policy } from '../../types/policy.js';
import type { Env } from '../../types/env.js';
import { isSecretName } from '../secrets.js';
import { DEFAULT_IMAGE, pickBackend } from './detect.js';
import {
  submoduleGitPaths,
  ownWorktreeGitDir,
  ownBranchRef,
  worktreePointerFiles,
} from './gitPaths.js';
import { seatbeltProfile } from './seatbelt.js';

export interface WrapResult {
  argv: string[];
  backend: string;
  note: string;
  failed?: boolean;
}

// Returns the argv you should really spawn. If no backend is there, it hands
// back the command UNCHANGED and says so, rather than faking a cage.
export function wrap(
  policy: Pick<Policy, 'sandbox'>,
  argv: string[],
  {
    worktree,
    scratch,
    env = {},
    stateDir,
  }: { worktree: string; scratch: string; env?: Env; stateDir: string },
): WrapResult {
  const cfg = policy.sandbox;
  if (!cfg.enabled) {
    return { argv, backend: 'none', note: 'sandbox layer off' };
  }

  const backend = pickBackend(policy);
  if (!backend.available) {
    return { argv, backend: 'none', note: `NOT SANDBOXED: ${backend.why}`, failed: true };
  }

  // A worktree's ".git" is a file pointing at the main checkout's real .git
  // folder. Every git command inside the cage needs to reach it.
  const commonGitDir = path.join(findRepoRoot(worktree), '.git');
  // The rest of .git that also runs code on the host, or belongs to someone
  // else. Both backends have to shut these the same way they shut .git/hooks.
  const submodule = submoduleGitPaths(commonGitDir);
  const worktreeGitDir = ownWorktreeGitDir(worktree);
  // Which branch this worktree is on, so the shared git folder can be narrowed
  // to what committing to THAT branch needs.
  const branchRef = ownBranchRef(worktreeGitDir);

  if (backend.name === 'docker') {
    const image = cfg.image ?? DEFAULT_IMAGE;
    // Mounted at the SAME path as on the host, not at /work. The agent's
    // prompt names host paths, so a different path would find nothing.
    const flags = [
      'run',
      '--rm',
      '-i',
      '--workdir',
      worktree,
      '--volume',
      `${worktree}:${worktree}`,
      // TMPDIR points at this host path, so it must exist in the container
      // too. Any write there fails without this mount.
      '--volume',
      `${scratch}:${scratch}`,
      // Same git folder need as seatbelt below.
      // Without this mount, every git command fails inside the container.
      '--volume',
      `${commonGitDir}:${commonGitDir}`,
      // Run as you, not root, so new files belong to you afterwards.
      '--user',
      `${process.getuid?.()}:${process.getgid?.()}`,
      // No new privileges, and drop every capability we do not need.
      '--security-opt',
      'no-new-privileges',
      '--cap-drop',
      'ALL',
      // Our user id has no entry inside the image, so git says "dubious
      // ownership". These vars mark this one path as safe, for this run only.
      '--env',
      'GIT_CONFIG_COUNT=1',
      '--env',
      'GIT_CONFIG_KEY_0=safe.directory',
      '--env',
      `GIT_CONFIG_VALUE_0=${worktree}`,
    ];
    if (!cfg.network) flags.push('--network', 'none');
    // Mounted AFTER the git folder above, because a later mount wins for
    // that subpath. Same reason as seatbelt: hooks must stay read-only.
    const hooksDir = path.join(commonGitDir, 'hooks');
    // Created, not just tested for, so this read-only mount always happens.
    // Without it an agent could drop a hook that runs uncaged on your commit.
    fs.mkdirSync(hooksDir, { recursive: true });
    flags.push('--volume', `${hooksDir}:${hooksDir}:ro`);
    // Same reason as hooks. ".git/config" is shared with your own checkout,
    // and keys written there run uncaged on your next git command.
    const gitConfigFile = path.join(commonGitDir, 'config');
    if (fs.existsSync(gitConfigFile))
      flags.push('--volume', `${gitConfigFile}:${gitConfigFile}:ro`);
    const gitConfigWorktreeFile = path.join(commonGitDir, 'config.worktree');
    if (fs.existsSync(gitConfigWorktreeFile))
      flags.push('--volume', `${gitConfigWorktreeFile}:${gitConfigWorktreeFile}:ro`);
    // Same reason again, for every submodule's own git dir under .git/modules.
    // A deeper mount wins over the one above it, so these stay read-only.
    for (const dir of submodule.hooks) flags.push('--volume', `${dir}:${dir}:ro`);
    for (const file of submodule.configs) flags.push('--volume', `${file}:${file}:ro`);
    // Other tickets' git metadata: read-only as a whole, then our own back.
    const worktreesDir = path.join(commonGitDir, 'worktrees');
    if (fs.existsSync(worktreesDir)) {
      flags.push('--volume', `${worktreesDir}:${worktreesDir}:ro`);
      if (worktreeGitDir) flags.push('--volume', `${worktreeGitDir}:${worktreeGitDir}`);
    }
    // Same reason as hooks: host git follows these after the cage.
    // A missing one is created, so the read-only mount always happens.
    if (worktreeGitDir) {
      for (const file of worktreePointerFiles(worktree, worktreeGitDir)) {
        if (!fs.existsSync(file)) fs.writeFileSync(file, '');
        flags.push('--volume', `${file}:${file}:ro`);
      }
    }
    // The paths that HOLD your work, shut the same way the paths that RUN code already were.
    // Docker narrows LESS than seatbelt here, and the reason is a real limit
    // rather than an oversight. Git updates a ref by creating `<ref>.lock` next to it and renaming
    // it into place, so the ref's DIRECTORY has to be writable. A docker bind mount is per path: it
    // cannot say "this directory is read-only except for creating these two names", which is
    // exactly what seatbelt's `(deny subpath)` + `(allow literal)` pair does express. So docker
    // shuts what a commit provably never touches — HEAD, the index, packed-refs, the main
    // checkout's own reflog, and info/ — and leaves refs/ and logs/refs/ writable. `--test` reports
    // which of the two you got.
    for (const rel of ['HEAD', 'index', 'packed-refs', 'info', path.join('logs', 'HEAD')]) {
      const full = path.join(commonGitDir, rel);
      if (fs.existsSync(full)) flags.push('--volume', `${full}:${full}:ro`);
    }
    for (const [k, v] of Object.entries(env)) {
      flags.push('--env', isSecretName(k) ? k : `${k}=${v}`);
    }
    for (const m of cfg.extraMounts ?? []) flags.push('--volume', m);
    flags.push(image, ...argv);
    return { argv: ['docker', ...flags], backend: 'docker', note: `image ${image}` };
  }

  // seatbelt: the rules go in a file, not on the command line, so quoting
  // can not break them. The file sits outside the worktree, out of reach.
  const realCommonGitDir = fs.realpathSync(commonGitDir);
  const profileDir = path.join(stateDir, 'sandbox');
  fs.mkdirSync(profileDir, { recursive: true });
  const profilePath = path.join(profileDir, `${path.basename(worktree)}.sb`);
  fs.writeFileSync(
    profilePath,
    seatbeltProfile({
      // Use the real path. On macOS /tmp is a link to /private/tmp,
      // and a rule that names the link matches nothing.
      worktree: fs.realpathSync(worktree),
      scratch: fs.existsSync(scratch) ? fs.realpathSync(scratch) : scratch,
      home: os.homedir(),
      commonGitDir: realCommonGitDir,
      allowNetwork: cfg.network,
      // Listed again from the REAL .git, so every deny below names a path
      // the kernel will actually match. Docker resolves links itself.
      submodule: submoduleGitPaths(realCommonGitDir),
      worktreeGitDir:
        worktreeGitDir && fs.existsSync(worktreeGitDir)
          ? fs.realpathSync(worktreeGitDir)
          : worktreeGitDir,
      branchRef,
    }),
  );

  return {
    argv: ['sandbox-exec', '-f', profilePath, ...argv],
    backend: 'seatbelt',
    note: `profile ${profilePath}`,
  };
}
