import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { check, checkPath } from '../../installKit/guardrails/layers/filesystem.js';
import { resolvePolicy, loadLevel } from '../../installKit/guardrails/resolve.js';
import { AGENT_CONFIG_PATHS } from '../../src/commands/install/install.js';
import { makeTempDir } from '../helpers/tempDir.js';

const WORKTREE = '/repo/.worktrees/2026-08-02-cage-the-coder';
const scopes = { TICKET_WORKTREE: WORKTREE, TICKET_SCRATCH: '/tmp/glafka-t-abc12345' };

// Uses the real policy, not a test copy.
function levelPolicy(level: number) {
  return resolvePolicy({ repoRoot: '/does/not/matter', levelOverride: level }).policy;
}

// Old bug: .env.glafka was blocked by mistake.
// It should still be readable.
for (const level of [2, 3, 4]) {
  test(`level ${level}: .env.glafka can still be read`, () => {
    const policy = levelPolicy(level);
    const result = check(
      policy,
      { op: 'read', filePath: path.join(WORKTREE, '.env.glafka') },
      scopes,
    );
    assert.equal(result.allow, true);
  });
}

test('a real project .env is still denied, right alongside .env.glafka in the same directory', () => {
  const policy = levelPolicy(2);
  const result = check(policy, { op: 'read', filePath: path.join(WORKTREE, '.env') }, scopes);
  assert.equal(result.allow, false);
});

test('other .env.* files (.env.local, .env.production) are still denied', () => {
  const policy = levelPolicy(2);
  for (const name of ['.env.local', '.env.production', '.env.test']) {
    const result = check(policy, { op: 'read', filePath: path.join(WORKTREE, name) }, scopes);
    assert.equal(result.allow, false, `${name} should still be denied`);
  }
});

// Old bug: .env files in subfolders were not blocked.
// Only the root .env file was checked before.
for (const level of [2, 3, 4]) {
  test(`level ${level}: a nested .env (packages/api/.env) is denied, not just the root one`, () => {
    const policy = levelPolicy(level);
    const result = check(
      policy,
      { op: 'read', filePath: path.join(WORKTREE, 'packages/api/.env') },
      scopes,
    );
    assert.equal(result.allow, false);
  });

  test(`level ${level}: a nested .env.* (apps/web/.env.local) is denied, not just the root one`, () => {
    const policy = levelPolicy(level);
    const result = check(
      policy,
      { op: 'read', filePath: path.join(WORKTREE, 'apps/web/.env.local') },
      scopes,
    );
    assert.equal(result.allow, false);
  });
}

test('a filename that merely starts with .env (.envx) is still allowed, at any depth', () => {
  const policy = levelPolicy(2);
  for (const p of ['.envx', 'packages/api/.envx']) {
    const result = check(policy, { op: 'read', filePath: path.join(WORKTREE, p) }, scopes);
    assert.equal(result.allow, true, p);
  }
});

// Reading this file is allowed, but writing it is not.
test('.env.glafka can be read but not written', () => {
  const policy = levelPolicy(2);
  const write = check(
    policy,
    { op: 'write', filePath: path.join(WORKTREE, '.env.glafka') },
    scopes,
  );
  assert.equal(write.allow, false);
});

// Old bug: these setup files were not protected.
// Overwriting them could turn off the safety checks.
for (const level of [2, 3, 4]) {
  for (const relPath of [
    '.claude/settings.json',
    '.gemini/settings.json',
    '.cursor/hooks.json',
    '.opencode/plugin/glafka-guardrails.js',
  ]) {
    test(`level ${level}: writing over its own cage (${relPath}) is denied`, () => {
      const policy = levelPolicy(level);
      const result = check(policy, { op: 'write', filePath: path.join(WORKTREE, relPath) }, scopes);
      assert.equal(result.allow, false);
    });
  }
}

// Old bug: on macOS, the temp folder path is a shortcut (symlink).
// This made writes to TICKET_SCRATCH get blocked by mistake.
for (const level of [2, 3, 4]) {
  test(`level ${level}: a real write into TICKET_SCRATCH is allowed, even though TMPDIR resolves through a symlink`, () => {
    const scratchDir = makeTempDir('2026-08-02-a-write-into-scratch');
    // This mainly matters on macOS, but the check still passes elsewhere.
    const target = path.join(scratchDir, 'output.txt');
    fs.writeFileSync(target, 'hi');

    const scopesReal = { TICKET_WORKTREE: WORKTREE, TICKET_SCRATCH: scratchDir };
    const result = check(levelPolicy(level), { op: 'write', filePath: target }, scopesReal);

    fs.rmSync(scratchDir, { recursive: true, force: true });
    assert.equal(result.allow, true, JSON.stringify(result));
  });
}

// --------------------------------------------------------------------------- Tests for past bug
// fixes. ---------------------------------------------------------------------------

// Old bug: the ".git" file itself could be overwritten.
// That file controls where the whole project points.
for (const level of [2, 3, 4]) {
  test(`level ${level}: the worktree's own .git pointer file cannot be written`, () => {
    const policy = levelPolicy(level);
    const result = check(policy, { op: 'write', filePath: path.join(WORKTREE, '.git') }, scopes);
    assert.equal(result.allow, false);
  });
}

test('ordinary files in the worktree are still writable', () => {
  const policy = levelPolicy(4);
  const result = check(
    policy,
    { op: 'write', filePath: path.join(WORKTREE, 'src', 'index.ts') },
    scopes,
  );
  assert.equal(result.allow, true);
});

// .glafka.json holds commands that run on your machine.
// It must not be writable by the agent.
for (const level of [2, 3, 4]) {
  test(`level ${level}: .glafka.json cannot be written by the agent`, () => {
    const policy = levelPolicy(level);
    const result = check(
      policy,
      { op: 'write', filePath: path.join(WORKTREE, '.glafka.json') },
      scopes,
    );
    assert.equal(result.allow, false);
  });
}

// Old bug: the ".env" rule also matched filenames like "config.env".
// It should only match the real .env file.
test('**/.env denies .env, not every file whose name ends in .env', () => {
  const policy = levelPolicy(2);
  const deny = (rel: string) =>
    check(policy, { op: 'read', filePath: path.join(WORKTREE, rel) }, scopes).allow === false;

  assert.equal(deny('.env'), true, '.env is the file the rule names');
  assert.equal(deny(path.join('src', '.env')), true, 'and in any directory');
  assert.equal(deny('config.env'), false, 'but config.env is the project’s own file');
  assert.equal(deny(path.join('src', 'schema.env')), false);
});

test('**/.env.* still denies the real variants', () => {
  const policy = levelPolicy(2);
  const deny = (rel: string) =>
    check(policy, { op: 'read', filePath: path.join(WORKTREE, rel) }, scopes).allow === false;

  assert.equal(deny('.env.local'), true);
  assert.equal(deny('.env.production'), true);
  assert.equal(deny('myconfig.env.local'), false);
});

test('the other denyWithin patterns still match what they name', () => {
  const policy = levelPolicy(4);
  const deny = (rel: string) =>
    check(policy, { op: 'write', filePath: path.join(WORKTREE, rel) }, scopes).allow === false;

  assert.equal(deny(path.join('.git', 'hooks', 'pre-commit')), true);
  assert.equal(deny(path.join('.claude', 'settings.json')), true);
  assert.equal(deny(path.join('node_modules', '.bin', 'tsc')), true);
  assert.equal(deny(path.join('deep', 'node_modules', '.bin', 'tsc')), true);
});

// macOS APFS (and Windows NTFS) do not distinguish case, so a case-sensitive
// denyWithin pattern was a bypassable cage: ".env" denied, ".ENV" allowed, same file on disk.
test('denyWithin matches regardless of case, on a case-insensitive volume', () => {
  const policy = levelPolicy(3);
  const deny = (rel: string) =>
    check(policy, { op: 'write', filePath: path.join(WORKTREE, rel) }, scopes).allow === false;

  assert.equal(deny('.env'), true);
  assert.equal(deny('.ENV'), true);
  assert.equal(deny('.Env'), true);
  assert.equal(deny(path.join('.claude', 'settings.json')), true);
  assert.equal(deny(path.join('.Claude', 'settings.json')), true);
  assert.equal(deny(path.join('.git', 'hooks', 'pre-commit')), true);
  assert.equal(deny(path.join('.GIT', 'HOOKS', 'pre-commit')), true);
});

// Drift guard. install.ts and the level files are two lists that must agree: every folder install
// writes agent config into has to be write-denied, or an agent can rewrite the rules it runs under. .kimi, .kimi-code and .github/skills were added to install long after the deny list was written, and nothing caught it.
for (const level of [2, 3, 4]) {
  test(`level ${level}: every agent-config path install writes is write-denied`, () => {
    const policy = levelPolicy(level);
    const deny = (rel: string) =>
      check(policy, { op: 'write', filePath: path.join(WORKTREE, rel) }, scopes).allow === false;

    for (const dir of AGENT_CONFIG_PATHS) {
      assert.equal(deny(path.join(...dir.split('/'), 'settings.json')), true, `${dir} is writable`);
    }
  });
}

// The rest of .github belongs to the project, so denying it wholesale would
// stop an agent from touching the CI it was asked to fix.
test('level 3: .github outside skills/ stays writable', () => {
  const policy = levelPolicy(3);
  const allowed = check(
    policy,
    { op: 'write', filePath: path.join(WORKTREE, '.github', 'workflows', 'ci.yml') },
    scopes,
  ).allow;

  assert.equal(allowed, true);
});

// path.resolve has never heard of `~`, so `~/.ssh/id_rsa` used to resolve to a folder
// called "~" inside the worktree and read as allowed, while the shell went to the real home folder.
test('a tilde path is placed where the shell would really put it', () => {
  const cfg = loadLevel(2).filesystem;
  const scopes = {
    TICKET_WORKTREE: '/tmp/probe-repo/.worktrees/2026-08-07-add-search-filters',
    TICKET_SCRATCH: '/tmp/glafka-t-abcd1234',
  };

  for (const target of ['~/.ssh/id_rsa', '~/.zshrc', '~/.claude/settings.json', '~']) {
    assert.equal(
      checkPath(cfg, 'read', target, scopes, scopes.TICKET_WORKTREE).allow,
      false,
      target,
    );
  }
  // The ~user form cannot be resolved, so it must not be waved through either.
  assert.equal(
    checkPath(cfg, 'write', '~otheruser/x', scopes, scopes.TICKET_WORKTREE).allow,
    false,
  );
  // A path with a tilde in the MIDDLE is an ordinary name, not a home folder.
  assert.equal(checkPath(cfg, 'read', 'docs/a~b.md', scopes, scopes.TICKET_WORKTREE).allow, true);
});
