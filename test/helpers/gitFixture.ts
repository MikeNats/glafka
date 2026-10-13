import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDir } from './tempDir.js';

// Building a git repo from scratch is slow.
// We build one copy per branch, then just copy the files each time.
const templates = new Map<string, string>();

function buildTemplate(branch: string): string {
  const repoRoot = makeTempDir('repo-tpl');
  const run = (args: string[]) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });

  run(['init', '-q', '-b', branch]);
  run(['config', 'user.email', 'test@glafka.dev']);
  run(['config', 'user.name', 'glafka test']);
  // `git commit` starts a DETACHED maintenance run whose objects/maintenance.lock
  // appears and vanishes under makeGitRepo's cpSync. 4 fails in 40; 0 with these.
  run(['config', 'maintenance.auto', 'false']);
  run(['config', 'gc.auto', '0']);
  fs.writeFileSync(path.join(repoRoot, 'README.md'), 'seed\n');
  run(['add', 'README.md']);
  run(['commit', '-q', '-m', 'seed']);

  return repoRoot;
}

// A real git repo for tests to use.
// Using real git avoids fake tests that hide real bugs.
export function makeGitRepo({ branch = 'main' }: { branch?: string } = {}): string {
  let template = templates.get(branch);
  if (!template) {
    template = buildTemplate(branch);
    templates.set(branch, template);
  }
  const repoRoot = makeTempDir('repo');
  fs.cpSync(template, repoRoot, { recursive: true });
  return repoRoot;
}

// Lets git use local file paths for a short time.
// Only needed for tests, since real code uses https/ssh.
export function withFileProtocol<T>(fn: () => T): T {
  const previous = process.env.GIT_ALLOW_PROTOCOL;
  process.env.GIT_ALLOW_PROTOCOL = 'file';
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.GIT_ALLOW_PROTOCOL;
    else process.env.GIT_ALLOW_PROTOCOL = previous;
  }
}

// A repo with one real submodule and one broken (phantom) entry.
// This copies a real-world problem so tests can catch it.
export function makeRepoWithSubmodule({ branch = 'main' }: { branch?: string } = {}): {
  repoRoot: string;
  childRepo: string;
} {
  const child = makeGitRepo({ branch });
  const repoRoot = makeGitRepo({ branch });
  const run = (args: string[]) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });

  // Git blocks local file paths for submodules by default.
  // We allow it here just for this test setup.
  run(['config', 'protocol.file.allow', 'always']);
  run(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', child, 'packages/real']);
  fs.appendFileSync(
    path.join(repoRoot, '.gitmodules'),
    `[submodule "packages/phantom"]\n\tpath = packages/phantom\n\turl = ${child}\n`,
  );
  run(['add', '.gitmodules']);
  run(['commit', '-q', '-m', 'add submodule + phantom entry']);

  return { repoRoot, childRepo: child };
}

// A fake "origin" repo on disk, so push tests don't need the network.
export function addBareRemote(
  repoRoot: string,
  { branch = 'main' }: { branch?: string } = {},
): string {
  const remoteDir = makeTempDir('remote');
  execFileSync('git', ['init', '-q', '--bare', '-b', branch], { cwd: remoteDir });
  // Same reason as buildTemplate: the push starts maintenance on the receiving
  // side. Nothing copies this remote, but it still writes as the suite exits.
  execFileSync('git', ['config', 'maintenance.auto', 'false'], { cwd: remoteDir });
  execFileSync('git', ['config', 'gc.auto', '0'], { cwd: remoteDir });
  execFileSync('git', ['remote', 'add', 'origin', remoteDir], { cwd: repoRoot });
  execFileSync('git', ['push', '-q', 'origin', branch], { cwd: repoRoot });
  // A real clone sets this automatically, but `remote add` does not.
  // We set it by hand so tests match real repos.
  execFileSync('git', ['remote', 'set-head', 'origin', branch], { cwd: repoRoot });
  return remoteDir;
}
