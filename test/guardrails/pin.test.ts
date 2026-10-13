import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pinFor, currentPin, assertUnchanged, repin } from '../../installKit/guardrails/pin.js';
import { makeTempDir } from '../helpers/tempDir.js';

function tempRepoRoot() {
  return makeTempDir('pin');
}

function writePolicy(repoRoot: string, policy: unknown) {
  const filePath = path.join(repoRoot, 'docs', 'glafka', 'guardrails.json');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(policy));
}

// Bug fixed here: pinFor used to drop the list of settings that were
// loosened past the level's default. Now it saves that list too.
test('pinFor stores which settings the project widened, not just the level', () => {
  const repoRoot = tempRepoRoot();
  writePolicy(repoRoot, {
    level: 3,
    exec: { allow: [{ cmd: 'sh', anyArgs: true }] },
    secrets: { keepEnv: ['AWS_SECRET_ACCESS_KEY'] },
  });

  const pin = pinFor({ repoRoot, now: '2026-01-01T00:00:00.000Z' });

  assert.deepEqual(pin.widened.sort(), ['exec.allow', 'secrets.keepEnv']);
  assert.equal(pin.level, 3);
});

test("pinFor's widened is empty for a project with no override at all", () => {
  const repoRoot = tempRepoRoot();

  const pin = pinFor({ repoRoot, now: '2026-01-01T00:00:00.000Z' });

  assert.deepEqual(pin.widened, []);
});

test('currentPin (what --repin compares against) also carries widened', () => {
  const repoRoot = tempRepoRoot();
  writePolicy(repoRoot, { level: 2, exec: { allow: [{ cmd: 'docker', anyArgs: true }] } });

  const pin = currentPin({ repoRoot });

  assert.deepEqual(pin.widened, ['exec.allow']);
});

// repin() rebuilds the pin the same way genesis did. It must keep the
// widened list too, not quietly drop it.
test('repin carries the fresh widened list forward, not just the level/hash', () => {
  const repoRoot = tempRepoRoot();
  writePolicy(repoRoot, { level: 2, exec: { allow: [{ cmd: 'docker', anyArgs: true }] } });
  const ticket = {
    id: '2026-08-07-add-dark-mode',
    worktree: null,
    guardrails: pinFor({ repoRoot, now: '2026-01-01T00:00:00.000Z' }),
  };

  const { next } = repin({ repoRoot, ticket, now: '2026-01-02T00:00:00.000Z' });

  assert.deepEqual(next.widened, ['exec.allow']);
});

// Checks that adding `widened` did not break assertUnchanged's real job:
// catching a policy change by comparing hashes.
test('assertUnchanged still detects a real policy change with widened present on the pin', () => {
  const repoRoot = tempRepoRoot();
  writePolicy(repoRoot, { level: 2, exec: { allow: [{ cmd: 'docker', anyArgs: true }] } });
  const ticket = {
    id: '2026-08-07-add-dark-mode',
    worktree: null,
    guardrails: pinFor({ repoRoot, now: '2026-01-01T00:00:00.000Z' }),
  };

  writePolicy(repoRoot, {
    level: 2,
    exec: {
      allow: [
        { cmd: 'docker', anyArgs: true },
        { cmd: 'sh', anyArgs: true },
      ],
    },
  });

  assert.throws(
    () => assertUnchanged({ repoRoot, ticket, action: 'run the agent' }),
    /guardrails policy changed/,
  );
});

// Bug: hook config files like .claude/settings.json are not read by resolvePolicy. So a coder that
// emptied its own hooks went unguarded, and the pin's hash never showed a change.
test("assertUnchanged catches a hook config being tampered with, even though resolvePolicy's own hash didn't move", () => {
  const repoRoot = tempRepoRoot();
  const claudeSettings = path.join(repoRoot, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(claudeSettings), { recursive: true });
  fs.writeFileSync(
    claudeSettings,
    JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'node hook.js' }] }] },
    }),
  );
  const ticket = {
    id: '2026-08-07-add-dark-mode',
    worktree: null,
    guardrails: pinFor({ repoRoot, now: '2026-01-01T00:00:00.000Z' }),
  };

  // This is what a coder might do: replace its own guard config with an empty one.
  fs.writeFileSync(claudeSettings, '{}');

  assert.throws(
    () => assertUnchanged({ repoRoot, ticket, action: 'run the agent' }),
    /guardrails policy changed/,
  );
});

test('assertUnchanged is silent when no hook config exists at all, both at pin time and at check time', () => {
  const repoRoot = tempRepoRoot();
  const ticket = {
    id: '2026-08-07-add-dark-mode',
    worktree: null,
    guardrails: pinFor({ repoRoot, now: '2026-01-01T00:00:00.000Z' }),
  };

  assertUnchanged({ repoRoot, ticket, action: 'run the agent' });
});

// Every harness reads its hook config from ITS OWN cwd, which for a running coder is
// the ticket's worktree, not repoRoot. Hashing only repoRoot meant a coder that disarmed its OWN worktree copy (e.g. `Write .Claude/settings.json`, or emptying `.claude/settings.json` in place) left the pin looking untouched forever.
test('assertUnchanged catches the WORKTREE copy of a hook config being tampered with', () => {
  const repoRoot = tempRepoRoot();
  const worktree = makeTempDir('pin-wt');
  const claudeSettings = path.join(worktree, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(claudeSettings), { recursive: true });
  fs.writeFileSync(
    claudeSettings,
    JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'node hook.js' }] }] },
    }),
  );
  const ticket = {
    id: '2026-08-07-add-dark-mode',
    worktree,
    guardrails: pinFor({ repoRoot, worktree, now: '2026-01-01T00:00:00.000Z' }),
  };

  // The coder disarms its OWN worktree's copy. repoRoot's copy (there is
  // none here) never changes.
  fs.writeFileSync(claudeSettings, '{}');

  assert.throws(
    () => assertUnchanged({ repoRoot, ticket, action: 'run the agent' }),
    /guardrails policy changed/,
  );
});

test("repoRoot's copy is no longer what gets checked once a worktree is pinned", () => {
  const repoRoot = tempRepoRoot();
  const worktree = makeTempDir('pin-wt');
  const ticket = {
    id: '2026-08-07-add-dark-mode',
    worktree,
    guardrails: pinFor({ repoRoot, worktree, now: '2026-01-01T00:00:00.000Z' }),
  };

  // Editing repoRoot's own copy (e.g. a maintainer's checkout, untouched by
  // the coder) must not be what assertUnchanged reacts to for this ticket.
  const repoRootSettings = path.join(repoRoot, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(repoRootSettings), { recursive: true });
  fs.writeFileSync(repoRootSettings, JSON.stringify({ hooks: {} }));

  assertUnchanged({ repoRoot, ticket, action: 'run the agent' });
});
