import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import * as exec from '../../installKit/guardrails/layers/exec.js';
import {
  buildEnv,
  describe as describeSecrets,
} from '../../installKit/guardrails/layers/secrets.js';
import { loadLevel } from '../../installKit/guardrails/resolve.js';
import { layers } from '../../installKit/guardrails/enforce.js';
import { CURSOR_NO_WRITE_HOOK, cursorHookInstalled } from '../../installKit/guardrails/harness.js';
import { ownBranchRef, seatbeltProfile } from '../../installKit/guardrails/layers/sandbox.js';
import { installAllHooks } from '../../installKit/bin/hooks/install.js';
import { makeTempDir } from '../helpers/tempDir.js';

const LEVELS = [2, 3, 4] as const;

// ---------------------------------------------------------------------------

// `git fetch <path>` and `git submodule add <url> <path>` reach outside the
// worktree. Both have ordinary in-tree forms, so the argument is judged rather than the subcommand: denying `fetch` outright would take real work away at level 2.
test('git fetch/submodule pointed at a path outside the checkout is refused', () => {
  const escapes = [
    ['git', 'fetch', '../other-repo'],
    ['git', 'fetch', '/Users/victim/private-repo'],
    ['git', 'fetch', '~/private-repo'],
    ['git', 'fetch', 'file:///Users/victim/private-repo'],
    ['git', 'fetch', '--all', '../other-repo'],
    ['git', 'submodule', 'add', '../other-repo'],
    ['git', 'submodule', 'add', 'https://example.com/x.git', '/Users/victim/pwned'],
  ];
  for (const level of LEVELS) {
    const policy = loadLevel(level);
    for (const argv of escapes) {
      const decision = exec.check(policy, { op: 'exec', argv });
      assert.equal(decision.allow, false, `level ${level}: ${argv.join(' ')}`);
    }
  }
});

test('ordinary git fetch and submodule work keeps working at level 2', () => {
  const policy = loadLevel(2);
  const fine = [
    ['git', 'fetch'],
    ['git', 'fetch', 'origin'],
    ['git', 'fetch', 'origin', 'main'],
    ['git', 'fetch', '--all'],
    ['git', 'fetch', '--prune', 'origin'],
    // A real remote is the network layer's business, not a path escape.
    ['git', 'fetch', 'https://github.com/a/b.git'],
    ['git', 'fetch', 'git@github.com:a/b.git'],
    ['git', 'submodule', 'update', '--init'],
    ['git', 'submodule', 'add', 'https://example.com/x.git', 'vendor/x'],
    // The word "clone" inside a commit message is not a subcommand.
    ['git', 'commit', '-m', 'fetch the thing'],
  ];
  for (const argv of fine) {
    const decision = exec.check(policy, { op: 'exec', argv });
    assert.equal(decision.allow, true, `${argv.join(' ')} — ${decision.reason}`);
  }
});

// ---------------------------------------------------------------------------

// GITHUB_TOKEN is on keepEnv because it is GitHub Copilot's sign-in credential. It
// also buys push/PR/merge, which exec.never withholds. So it goes only to the agent it belongs to.
const SOURCE_ENV = {
  GITHUB_TOKEN: 'ghp_REAL',
  GH_TOKEN: 'gho_REAL',
  ANTHROPIC_API_KEY: 'sk-ant-REAL',
  AWS_SECRET_ACCESS_KEY: 'aws_REAL',
  PATH: '/usr/bin',
};

test('GITHUB_TOKEN reaches Copilot, and no other agent', () => {
  for (const level of LEVELS) {
    const policy = loadLevel(level);
    for (const cmd of ['copilot -p', 'gh copilot suggest', '/usr/local/bin/copilot']) {
      const { env } = buildEnv(policy, SOURCE_ENV, {}, { agentCmd: cmd });
      assert.equal(env.GITHUB_TOKEN, 'ghp_REAL', `level ${level}, ${cmd}`);
    }
    for (const cmd of ['claude -p', 'gemini', 'kimi', 'opencode run']) {
      const { env } = buildEnv(policy, SOURCE_ENV, {}, { agentCmd: cmd });
      assert.equal(env.GITHUB_TOKEN, undefined, `level ${level}, ${cmd}`);
    }
  }
});

// The regression an earlier round already paid for: keepEnv carries a credential for every supported
// agent, and dropping the wrong one means that agent can never sign in.
test('the model API keys are untouched by the agent gate', () => {
  for (const cmd of ['claude -p', 'copilot', 'gemini', null]) {
    const { env } = buildEnv(loadLevel(2), SOURCE_ENV, {}, { agentCmd: cmd });
    assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-REAL', String(cmd));
  }
});

test('an unresolved agent command keeps the token, and says so', () => {
  const { env, warnings } = buildEnv(loadLevel(2), SOURCE_ENV, {}, { agentCmd: null });
  assert.equal(env.GITHUB_TOKEN, 'ghp_REAL', 'never break a sign-in we cannot rule out');
  assert.ok(
    warnings.some((w) => w.includes('WITHOUT checking which agent')),
    'the remaining surface has to be stated, not silent',
  );
});

test('dropping it for a foreign agent is explained, not silent', () => {
  const { warnings } = buildEnv(loadLevel(2), SOURCE_ENV, {}, { agentCmd: 'claude -p' });
  assert.ok(warnings.some((w) => w.includes('GITHUB_TOKEN') && w.includes('Copilot')));
});

test('GH_TOKEN and AWS keys still go to nobody', () => {
  for (const cmd of ['copilot', 'claude -p', null]) {
    const { env } = buildEnv(loadLevel(2), SOURCE_ENV, {}, { agentCmd: cmd });
    assert.equal(env.GH_TOKEN, undefined);
    assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  }
});

test('--explain says the token is conditional', () => {
  const lines = describeSecrets(loadLevel(2)).join('\n');
  assert.match(lines, /GITHUB_TOKEN.*conditional/s);
});

// ---------------------------------------------------------------------------

// The approval layer was live, wired and unreachable: nothing in the tree ever built
// an `approval` action, so `enabled` and `needsHumanYes` changed nothing while `--explain` printed seven actions as gated.
test('the approval layer is gone, not just quiet', () => {
  assert.equal('approval' in layers, false, 'the layer must not be routable any more');
  assert.equal(
    fs.existsSync(new URL('../../guardrails/layers/approval.ts', import.meta.url)),
    false,
  );
});

test('no level file still declares an enforcement that does not exist', () => {
  for (const level of [0, 1, 2, 3, 4]) {
    const policy = loadLevel(level) as unknown as Record<string, unknown>;
    assert.equal(policy.approval, undefined, `level ${level} still has an approval block`);
    // The two settings the live hostexec layer really reads moved, they did
    // not vanish — deleting those would have turned off a working spotlight.
    assert.ok(policy.hostexec, `level ${level} lost its hostexec config`);
  }
});

test('hostexec still reads its settings from the new home', () => {
  const policy = loadLevel(2);
  assert.equal(typeof policy.hostexec.flagHostExecutingChanges, 'boolean');
  assert.ok(Array.isArray(policy.hostexec.hostExecutingPatterns));
});

// ---------------------------------------------------------------------------

// Installing a package runs its postinstall on the host. That grant stays
// (it is ordinary work), so `--explain` has to name it or a reader assumes the npx/dlx denials covered the whole class.
test('the postinstall grant is named where the gaps are listed', async () => {
  const { explain } = await import('../../installKit/guardrails/explain.js');
  const repoRoot = makeTempDir('explain');
  execFileSync('git', ['init', '-q', repoRoot]);
  fs.mkdirSync(path.join(repoRoot, 'docs', 'glafka'), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, 'docs', 'glafka', 'guardrails.json'),
    JSON.stringify({ level: 2 }),
  );

  const { text } = explain({ repoRoot });
  assert.match(text, /postinstall/i);
  assert.match(text, /still gets through/);
});

// ---------------------------------------------------------------------------

// Cursor has no before-write hook, so the filesystem layer
// cannot block a write there at any level. `install` reported plain success.
test('installing on Cursor says write confinement is not enforced there', () => {
  const repoRoot = makeTempDir('cursor');
  const results = installAllHooks(repoRoot, repoRoot);

  const cursor = results.find((r) => r.name === 'Cursor');
  assert.ok(cursor, 'Cursor must still be installed');
  assert.equal(cursor.caveat, CURSOR_NO_WRITE_HOOK);
  assert.match(String(cursor.caveat), /NOT enforced/);

  // Every other harness enforces writes, so none of them carries this caveat.
  for (const other of results.filter((r) => r.name !== 'Cursor')) {
    assert.equal(other.caveat, null, `${other.name} must not claim a Cursor-only gap`);
  }
});

test('the caveat is raised only for a repo where Cursor is actually wired up', () => {
  const repoRoot = makeTempDir('cursor2');
  assert.equal(cursorHookInstalled(repoRoot), false, 'nothing installed yet');

  installAllHooks(repoRoot, repoRoot);
  assert.equal(cursorHookInstalled(repoRoot), true);
});

test('an unreadable .cursor/hooks.json counts as not installed', () => {
  const repoRoot = makeTempDir('cursor3');
  fs.mkdirSync(path.join(repoRoot, '.cursor'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, '.cursor', 'hooks.json'), '{ not json');
  assert.equal(cursorHookInstalled(repoRoot), false);
});

// ---------------------------------------------------------------------------

// The level-4 wall mounted the whole shared .git writable. The four denies covered
// the paths that RUN code; nothing covered the paths that HOLD your work.
test('the seatbelt profile shuts the paths a commit never writes', () => {
  const profile = seatbeltProfile({
    worktree: '/repo/.worktrees/2026-08-07-add-search-filters',
    scratch: '/tmp/scratch',
    home: '/Users/me',
    commonGitDir: '/repo/.git',
    allowNetwork: false,
    branchRef: 'refs/heads/glafka/2026-08-07-add-search-filters',
  });

  for (const shut of [
    '(deny file-write* (subpath "/repo/.git/refs"))',
    '(deny file-write* (subpath "/repo/.git/logs"))',
    '(deny file-write* (literal "/repo/.git/HEAD"))',
    '(deny file-write* (literal "/repo/.git/index"))',
    '(deny file-write* (literal "/repo/.git/packed-refs"))',
  ]) {
    assert.ok(profile.includes(shut), `missing: ${shut}`);
  }

  // Given back: only this ticket's own ref and reflog, plus their .lock
  // siblings — git writes <ref>.lock and renames it into place.
  for (const given of [
    '(literal "/repo/.git/refs/heads/glafka/2026-08-07-add-search-filters")',
    '(literal "/repo/.git/refs/heads/glafka/2026-08-07-add-search-filters.lock")',
    '(literal "/repo/.git/logs/refs/heads/glafka/2026-08-07-add-search-filters")',
  ]) {
    assert.ok(profile.includes(given), `missing: ${given}`);
  }

  // Another ticket's branch is NOT given back.
  assert.equal(profile.includes('refs/heads/glafka/2026-08-02-the-seatbelt-profile"'), false);
});

test('a detached HEAD is not narrowed, and the profile says why', () => {
  const profile = seatbeltProfile({
    worktree: '/repo/.worktrees/2026-08-07-add-search-filters',
    scratch: '/tmp/scratch',
    home: '/Users/me',
    commonGitDir: '/repo/.git',
    allowNetwork: false,
    branchRef: null,
  });
  // Narrowing with no ref to give back would stop the coder committing at all.
  assert.equal(profile.includes('(deny file-write* (subpath "/repo/.git/refs"))'), false);
  assert.match(profile, /NOT narrowed/);
});

test('ownBranchRef reads the branch from the worktree git dir, and null when detached', () => {
  const dir = makeTempDir('head');
  fs.writeFileSync(
    path.join(dir, 'HEAD'),
    'ref: refs/heads/glafka/2026-08-07-add-search-filters\n',
  );
  assert.equal(ownBranchRef(dir), 'refs/heads/glafka/2026-08-07-add-search-filters');

  fs.writeFileSync(path.join(dir, 'HEAD'), '9c1f0a2b3c4d5e6f\n');
  assert.equal(ownBranchRef(dir), null, 'a detached HEAD names no branch');

  assert.equal(ownBranchRef(null), null);
  assert.equal(ownBranchRef('/nope/does/not/exist'), null);
});
