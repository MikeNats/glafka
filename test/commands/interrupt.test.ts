import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { makeGitRepo } from '../helpers/gitFixture.js';
import { makeTempDir } from '../helpers/tempDir.js';
import { isolationProfilePath, writeDoc } from '../../src/memory/docsStore.js';

// Setup takes minutes (git worktree add, then the project's
// bootstrapCmd, then setupCmd), so Ctrl-C during it is normal use, not an edge case.
// A signal is not a throw, so acquireResources' catch never ran and every interrupt
// stranded a full checkout with its dependencies plus a branch and a lock.

// The real built CLI, because the whole point is what a signal does to a process.
const BIN = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'dist',
  'installKit',
  'bin',
  'glafka.js',
);

function repoWithSlowSetup() {
  const repoRoot = makeGitRepo();
  // bootstrapCmd touches a file, then holds setup open. The file is the signal
  // that setup reached the interruptible part; it lives outside the worktree so
  // cleanup cannot take it with it.
  const marker = path.join(makeTempDir('interrupt-marker'), `${randomUUID()}.started`);
  writeDoc(
    isolationProfilePath(repoRoot),
    JSON.stringify({ workspace: { bootstrapCmd: `touch ${marker} && sleep 60` } }),
  );
  execFileSync('git', ['add', '-A'], { cwd: repoRoot });
  execFileSync('git', ['commit', '-qm', 'isolation profile'], { cwd: repoRoot });
  return { repoRoot, marker };
}

function cli(repoRoot: string, args: string[]) {
  return spawnSync('node', [BIN, ...args], { cwd: repoRoot, encoding: 'utf8' });
}

// Waiting for the worktree DIRECTORY is not enough: it appears while `git worktree
// add` is still running, and interrupting mid-add leaves a half-made checkout —
// which failed about one run in three. The marker proves add, submodules, seeding
// and ports are all done and setup is sitting in bootstrapCmd.
async function waitForBootstrap(repoRoot: string, id: string, marker: string) {
  const worktree = path.join(repoRoot, '.worktrees', id);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !fs.existsSync(marker)) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(fs.existsSync(marker), true, 'bootstrapCmd never ran, so setup was not interrupted');
  assert.equal(fs.existsSync(worktree), true, 'the worktree must exist by the time bootstrap runs');
  return worktree;
}

test('a signal during setup leaves no worktree, branch or provisioning lock', async () => {
  const { repoRoot, marker } = repoWithSlowSetup();
  const created = cli(repoRoot, ['create', 'interrupted setup']);
  const id = `${created.stdout}${created.stderr}`.match(/\d{4}-\d{2}-\d{2}-[a-z0-9-]+/)?.[0];
  assert.ok(id, `create gave no id: ${created.stdout}${created.stderr}`);

  const specFile = path.join(makeTempDir('interrupt-spec'), 'spec.md');
  const planFile = path.join(path.dirname(specFile), 'plan.md');
  fs.writeFileSync(specFile, '# spec\n\ndo a thing\n');
  fs.writeFileSync(planFile, '1. do a thing\n');
  cli(repoRoot, ['spec', id, specFile, '--title', 'interrupted']);

  // Detached, so the signal reaches the whole group the way a terminal's would.
  const child = spawn('node', [BIN, 'plan', id, planFile], {
    cwd: repoRoot,
    detached: true,
    stdio: 'ignore',
  });

  await waitForBootstrap(repoRoot, id, marker);
  process.kill(-child.pid!, 'SIGINT');
  await new Promise((resolve) => child.on('exit', resolve));

  assert.equal(
    fs.existsSync(path.join(repoRoot, '.worktrees', id)),
    false,
    'the worktree must be gone',
  );
  const worktrees = execFileSync('git', ['worktree', 'list'], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(worktrees.includes('.worktrees'), false, 'git must not still know the worktree');
  const branches = execFileSync('git', ['branch', '--list', 'glafka/*'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
  assert.equal(branches, '', 'the branch must be gone');
  const locks = fs
    .readdirSync(path.join(repoRoot, '.glafka', 'tickets'))
    .filter((n) => n.endsWith('.provisioning'));
  assert.deepEqual(locks, [], 'the provisioning lock must be gone');

  fs.rmSync(repoRoot, { recursive: true, force: true });
});

// SIGKILL cannot be handled, so this is the case the sweep exists for. It used to
// find only the lock: the worktree belonged to an "active" ticket, so it was skipped.
test('the sweep recovers a worktree left by a kill no handler can catch', async () => {
  const { repoRoot, marker } = repoWithSlowSetup();
  const created = cli(repoRoot, ['create', 'killed setup']);
  const id = `${created.stdout}${created.stderr}`.match(/\d{4}-\d{2}-\d{2}-[a-z0-9-]+/)?.[0];
  assert.ok(id);

  const specFile = path.join(makeTempDir('kill-spec'), 'spec.md');
  const planFile = path.join(path.dirname(specFile), 'plan.md');
  fs.writeFileSync(specFile, '# spec\n\ndo a thing\n');
  fs.writeFileSync(planFile, '1. do a thing\n');
  cli(repoRoot, ['spec', id, specFile, '--title', 'killed']);

  const child = spawn('node', [BIN, 'plan', id, planFile], {
    cwd: repoRoot,
    detached: true,
    stdio: 'ignore',
  });
  await waitForBootstrap(repoRoot, id, marker);
  process.kill(-child.pid!, 'SIGKILL');
  await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(fs.existsSync(path.join(repoRoot, '.worktrees', id)), true, 'SIGKILL must leak');

  // --kill is what the sweep tells a non-terminal caller to use, and it was
  // rejected as an unknown flag until now.
  const swept = cli(repoRoot, ['lysis', id, '--sweep', '--kill', 'all']);
  const out = `${swept.stdout}${swept.stderr}`;
  assert.doesNotMatch(out, /unknown flag/, out);
  assert.match(out, /deleted \.worktrees/, out);

  assert.equal(
    fs.existsSync(path.join(repoRoot, '.worktrees', id)),
    false,
    'the sweep must remove the leftover worktree, not just the lock',
  );
  const branches = execFileSync('git', ['branch', '--list', 'glafka/*'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
  assert.equal(branches, '', 'and its branch');

  fs.rmSync(repoRoot, { recursive: true, force: true });
});
