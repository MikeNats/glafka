import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeTempDir } from '../helpers/tempDir.js';

import {
  evaluateActions,
  evaluateFromCwd,
  expandExec,
  findRepoRoot,
  ticketIdFrom,
} from '../../installKit/guardrails/core.js';
import { ticketFiles, ticketsDir } from '../../src/ticket/paths.js';
import { makeGitRepo } from '../helpers/gitFixture.js';
import type { Action } from '../../installKit/guardrails/types/action.js';

// macOS's temp folder is a symlink. This fixes the real path
// so it matches what the code expects.
function tempRepoRoot() {
  return fs.realpathSync(makeTempDir('guardrails'));
}

function writePolicy(repoRoot: string, policy: unknown) {
  const filePath = path.join(repoRoot, 'docs', 'glafka', 'guardrails.json');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(policy));
}

// This only checks the file exists. It does not check what is inside.
function makeTicket(stateDir: string, id: string) {
  const { ticketFile } = ticketFiles(ticketsDir(stateDir), id);
  fs.mkdirSync(path.dirname(ticketFile), { recursive: true });
  fs.writeFileSync(ticketFile, '{}');
}

// --------------------------------------------------------------------------- findRepoRoot
// ---------------------------------------------------------------------------

// findRepoRoot used to run git every time. Now it just checks files.
// These tests make sure it still matches real git.

test('findRepoRoot resolves an ordinary checkout directly from its own .git directory', () => {
  const repoRoot = fs.realpathSync(makeGitRepo());
  assert.equal(findRepoRoot(repoRoot), repoRoot);
});

test('findRepoRoot walks up from a nested subdirectory to the same root', () => {
  const repoRoot = fs.realpathSync(makeGitRepo());
  const nested = path.join(repoRoot, 'deep', 'nested', 'dir');
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(findRepoRoot(nested), repoRoot);
});

// A worktree's .git file points back to the main repo.
// This must find the main repo, not the worktree.
test('findRepoRoot resolves a linked worktree back to the main checkout, matching real git', () => {
  const repoRoot = fs.realpathSync(makeGitRepo());
  execFileSync(
    'git',
    ['worktree', 'add', '-q', '-b', 'feature', '.worktrees/2026-08-02-cage-the-coder'],
    {
      cwd: repoRoot,
    },
  );
  const worktree = path.join(repoRoot, '.worktrees', '2026-08-02-cage-the-coder');

  const real = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: worktree,
    encoding: 'utf8',
  }).trim();

  assert.equal(findRepoRoot(worktree), path.dirname(real));
  assert.equal(findRepoRoot(worktree), repoRoot);
});

test('findRepoRoot walks up from a nested subdirectory inside a worktree too', () => {
  const repoRoot = fs.realpathSync(makeGitRepo());
  execFileSync(
    'git',
    ['worktree', 'add', '-q', '-b', 'feature2', '.worktrees/2026-08-02-find-the-repo-root'],
    {
      cwd: repoRoot,
    },
  );
  const nested = path.join(repoRoot, '.worktrees', '2026-08-02-find-the-repo-root', 'src', 'lib');
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(findRepoRoot(nested), repoRoot);
});

test('findRepoRoot throws when cwd is not inside any git repo', () => {
  const outsideAnyRepo = makeTempDir('not-a-repo');
  assert.throws(() => findRepoRoot(outsideAnyRepo));
});

// --------------------------------------------------------------------------- ticketIdFrom
// ---------------------------------------------------------------------------

test('ticketIdFrom reads the folder right after .worktrees', () => {
  assert.equal(
    ticketIdFrom('/repo/.worktrees/2026-08-02-cage-the-coder'),
    '2026-08-02-cage-the-coder',
  );
  assert.equal(
    ticketIdFrom('/repo/.worktrees/2026-08-02-cage-the-coder/src'),
    '2026-08-02-cage-the-coder',
  );
});

test('ticketIdFrom is null outside a worktree — this is what tells evaluateActions to stand aside', () => {
  assert.equal(ticketIdFrom('/repo'), null);
});

// Old bug: path.resolve() removed ".." before checking the path.
// Now we check the raw path first, so the real ticket id is not hidden.
test('ticketIdFrom still finds the ticket in a path built to walk out of its worktree', () => {
  assert.equal(
    ticketIdFrom('/repo/.worktrees/2026-08-02-cage-the-coder/../../evil.js'),
    '2026-08-02-cage-the-coder',
  );
});

// --------------------------------------------------------------------------- expandExec
// ---------------------------------------------------------------------------

// expandExec only reads policy.exec, so this test object only
// needs that one field, not the full Policy type.
function execPolicy(overrides: { enabled: boolean; allowShellStrings: boolean }) {
  return { exec: { allow: [], never: [], ...overrides } };
}

test('expandExec passes non-exec actions through untouched', () => {
  const action: Action = { op: 'read', filePath: '/repo/x.js' };
  assert.deepEqual(expandExec(action, execPolicy({ enabled: true, allowShellStrings: false })), [
    action,
  ]);
});

test('expandExec splits a shell command string into one action per segment', () => {
  const action: Action = { op: 'exec', commandString: 'ls && pwd' };
  const [first, second] = expandExec(
    action,
    execPolicy({ enabled: true, allowShellStrings: true }),
  );
  assert.ok('argv' in first);
  assert.deepEqual(first.argv, ['ls']);
  assert.ok('argv' in second);
  assert.deepEqual(second.argv, ['pwd']);
});

// Old bug: ">" was not marked as unsafe.
// A command like "cat payload > ~/.zshenv" could slip past checks.
test('expandExec marks a command containing redirection unreadable when shell strings are refused', () => {
  const action: Action = { op: 'exec', commandString: 'cat payload > ~/.zshenv' };
  const [result] = expandExec(action, execPolicy({ enabled: true, allowShellStrings: false }));
  assert.ok('unreadable' in result, 'redirection must not split into a plain, checkable argv');
  assert.ok(!('argv' in result));
});

// This used to pass the redirection through to the weak coarse scan at any
// level with allowShellStrings on (level 2), which only checks whether the string mentions a never-listed COMMAND. A redirection names no command at all — it hides a WRITE TARGET — so that scan did nothing to stop it, and a plain `cat payload > ~/.zshenv` (no fd- dup trick needed) was simply allowed at level 2. Redirection must always be refused, regardless of allowShellStrings.
test('expandExec refuses redirection even at a level that allows shell strings generally', () => {
  const action: Action = { op: 'exec', commandString: 'cat payload > ~/.zshenv' };
  const [result] = expandExec(action, execPolicy({ enabled: true, allowShellStrings: true }));
  assert.ok(
    'unreadable' in result,
    'a redirection must be refused outright, not handed to the coarse "mentions a never-command" scan',
  );
});

// The coarse scan is still the right fallback for reasons OTHER than redirection (eval, $(), a bare
// $VAR, …) — those at least hide a COMMAND, which the coarse scan can still spot by word-matching. Only redirection's "hides a write target, not a command" case needed narrowing.
test('expandExec still falls through to the coarse scan for non-redirection unreadable reasons', () => {
  const action: Action = { op: 'exec', commandString: 'eval "$CMD"' };
  const [result] = expandExec(action, execPolicy({ enabled: true, allowShellStrings: true }));
  assert.equal(result, action, 'non-redirection reasons are unchanged by this fix');
});

// Old bug: "g\it push" did not match "git", so it skipped the deny check.
// But a shell still runs it as "git push".
test('expandExec reads a backslash-escaped command name for what it really is', () => {
  const action: Action = { op: 'exec', commandString: 'g\\it push origin main' };
  const [result] = expandExec(action, execPolicy({ enabled: true, allowShellStrings: true }));
  assert.ok('argv' in result);
  assert.deepEqual(result.argv, ['git', 'push', 'origin', 'main']);
});

// --------------------------------------------------------------------------- evaluateActions — level
// 0, no ticket, and deny cases ---------------------------------------------------------------------------

test('level 0 (no policy file) allows everything without even looking at the action', () => {
  const repoRoot = tempRepoRoot();
  const result = evaluateActions({
    repoRoot,
    cwd: path.join(repoRoot, '.worktrees', '2026-08-02-level-zero-allows-everything'),
    baseActions: [{ op: 'exec', argv: ['git', 'push'] }],
  });
  assert.deepEqual(result, { ok: true });
});

test('a cwd outside any ticket worktree is not a caged coder — stands aside even at a high level', () => {
  const repoRoot = tempRepoRoot();
  writePolicy(repoRoot, { level: 2 });
  const result = evaluateActions({
    repoRoot,
    cwd: repoRoot,
    baseActions: [{ op: 'exec', argv: ['git', 'push'] }],
  });
  assert.deepEqual(result, { ok: true });
});

test("a never-allowed command is denied for a ticket's worktree", () => {
  const repoRoot = tempRepoRoot();
  writePolicy(repoRoot, { level: 2 });
  const result = evaluateActions({
    repoRoot,
    cwd: path.join(repoRoot, '.worktrees', '2026-08-02-cage-the-coder'),
    baseActions: [{ op: 'exec', argv: ['git', 'push'] }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.layer, 'exec');
  assert.match(result.reason, /git push.*never allowed/);
});

// "g\it push" must be caught the same as "git push".
// It must not be treated as an unknown, allowed command.
test('a backslash-escaped never-allowed command is still denied, not waved through as unknown', () => {
  const repoRoot = tempRepoRoot();
  writePolicy(repoRoot, { level: 2 });
  const result = evaluateActions({
    repoRoot,
    cwd: path.join(repoRoot, '.worktrees', '2026-08-02-cage-the-coder'),
    baseActions: [{ op: 'exec', commandString: 'g\\it push origin main' }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.layer, 'exec');
  assert.match(result.reason, /git push.*never allowed/);
});

// Level 2's only control over an unrecognized command name is the never-list, since
// onUnknownAction is "allow" there. A backslash followed by a real newline used to survive into the tokenized word instead of being removed like a real shell removes it, so "git" split across the escape read as an unrecognized name and fell through to allow.
test('level 2: a backslash-newline split command name is still denied, not waved through as unknown', () => {
  const repoRoot = tempRepoRoot();
  writePolicy(repoRoot, { level: 2 });
  const result = evaluateActions({
    repoRoot,
    cwd: path.join(repoRoot, '.worktrees', '2026-08-02-cage-the-coder'),
    baseActions: [{ op: 'exec', commandString: 'gi\\\nt push origin main' }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.layer, 'exec');
  assert.match(result.reason, /git push.*never allowed/);
});

test('first denied action wins — a later allowed action never overrides it', () => {
  const repoRoot = tempRepoRoot();
  writePolicy(repoRoot, { level: 2 });
  const result = evaluateActions({
    repoRoot,
    cwd: path.join(repoRoot, '.worktrees', '2026-08-02-cage-the-coder'),
    baseActions: [
      { op: 'exec', argv: ['git', 'push'] },
      { op: 'exec', argv: ['ls'] },
    ],
  });
  assert.equal(result.ok, false);
});

// A Bash redirect to ~/.zshenv must be blocked.
// It should work the same as a direct Write to that file.
test('level 3 denies a Bash redirection that writes outside the worktree, matching what Write already denies', () => {
  const repoRoot = tempRepoRoot();
  writePolicy(repoRoot, { level: 3 });
  const result = evaluateActions({
    repoRoot,
    cwd: path.join(repoRoot, '.worktrees', '2026-08-02-cage-the-coder'),
    baseActions: [{ op: 'exec', commandString: 'cat payload > ~/.zshenv' }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.layer, 'exec');
});

// Old bug: a ";" inside quotes was read as a command separator.
// This wrongly split one command into two.
test('level 3 allows a git commit whose quoted message contains a semicolon', () => {
  const repoRoot = tempRepoRoot();
  writePolicy(repoRoot, { level: 3 });
  const result = evaluateActions({
    repoRoot,
    cwd: path.join(repoRoot, '.worktrees', '2026-08-02-cage-the-coder'),
    baseActions: [{ op: 'exec', commandString: "git commit -m 'fix a; then b'" }],
  });
  assert.deepEqual(result, { ok: true });
});

// `cp` is allow-listed with anyArgs, but nothing looked at the path it was copying
// TO. That let the coder overwrite guardrails.json itself, turning the cage off for its very next tool call.
test('level 3: cp cannot write outside the worktree, not even the policy file that cages it', () => {
  const repoRoot = tempRepoRoot();
  writePolicy(repoRoot, { level: 3 });
  const result = evaluateActions({
    repoRoot,
    cwd: path.join(repoRoot, '.worktrees', '2026-08-02-cage-the-coder'),
    baseActions: [{ op: 'exec', argv: ['cp', 'evil.json', '../../docs/glafka/guardrails.json'] }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.layer, 'execFilesystem');
});

test('level 3: cp still works for an ordinary copy inside the worktree', () => {
  const repoRoot = tempRepoRoot();
  writePolicy(repoRoot, { level: 3 });
  const result = evaluateActions({
    repoRoot,
    cwd: path.join(repoRoot, '.worktrees', '2026-08-02-cage-the-coder'),
    baseActions: [{ op: 'exec', argv: ['cp', 'a.txt', 'b.txt'] }],
  });
  assert.deepEqual(result, { ok: true });
});

test('an allowed command at level 2 is allowed', () => {
  const repoRoot = tempRepoRoot();
  writePolicy(repoRoot, { level: 2 });
  const result = evaluateActions({
    repoRoot,
    cwd: path.join(repoRoot, '.worktrees', '2026-08-02-cage-the-coder'),
    baseActions: [{ op: 'exec', argv: ['ls', '-la'] }],
  });
  assert.deepEqual(result, { ok: true });
});

// --------------------------------------------------------------------------- evaluateFromCwd — the
// function other tools call to check actions ---------------------------------------------------------------------------

test('evaluateFromCwd finds the repo root from a real git checkout and denies the same way', () => {
  const repoRoot = tempRepoRoot();
  execFileSync('git', ['init', '-q'], { cwd: repoRoot });
  writePolicy(repoRoot, { level: 2 });
  const worktreeCwd = path.join(repoRoot, '.worktrees', '2026-08-02-cage-the-coder');
  fs.mkdirSync(worktreeCwd, { recursive: true });

  const result = evaluateFromCwd({
    cwd: worktreeCwd,
    baseActions: [{ op: 'exec', argv: ['git', 'push'] }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.layer, 'exec');
});

test('evaluateFromCwd denies rather than throws when cwd is not inside a git repo', () => {
  const outsideAnyRepo = makeTempDir('not-a-repo');
  const result = evaluateFromCwd({ cwd: outsideAnyRepo, baseActions: [] });
  assert.equal(result.ok, false);
  assert.match(result.reason, /could not find the repo/);
});

// --------------------------------------------------------------------------- evaluateActions — when
// cwd is not the worktree, get the ticket id from the file path instead ---------------------------------------------------------------------------

test("a same-session subagent (cwd = main checkout) is still caged, via a real ticket's own filePath", () => {
  const repoRoot = tempRepoRoot();
  writePolicy(repoRoot, { level: 2 });
  const stateDir = path.join(repoRoot, '.glafka');
  makeTicket(stateDir, '2026-08-02-cage-the-coder');

  const result = evaluateActions({
    repoRoot,
    cwd: repoRoot, // cwd stays the same — that is the bug we test
    baseActions: [
      // A read action has a filePath we can get the ticket id from.
      // Exec actions don't, so this stands in for an earlier tool call.
      {
        op: 'read',
        filePath: path.join(repoRoot, '.worktrees', '2026-08-02-cage-the-coder', 'x.js'),
      },
      { op: 'exec', argv: ['git', 'push'] },
    ],
  });
  assert.equal(result.ok, false);
  assert.equal(result.layer, 'exec');
});

// Old bug: a fake ticket id in the path was treated as "no ticket".
// It was wrongly allowed. Now it is denied at level 2 and above.
test('a made-up ticket id in a filePath is denied, not silently waved through as if there were no ticket at all', () => {
  const repoRoot = tempRepoRoot();
  writePolicy(repoRoot, { level: 2 });
  // 2026-08-07-sweep-the-leftovers does not exist.

  const result = evaluateActions({
    repoRoot,
    cwd: repoRoot,
    baseActions: [
      {
        op: 'write',
        filePath: path.join(repoRoot, '.worktrees', '2026-08-07-sweep-the-leftovers', 'x.js'),
      },
    ],
  });
  assert.equal(result.ok, false);
  assert.equal(result.layer, 'core');
});

// Level 1 (audit) only watches. It does not block here.
test('...but at level 1 (audit only) the same made-up id still just stands aside', () => {
  const repoRoot = tempRepoRoot();
  writePolicy(repoRoot, { level: 1 });
  const result = evaluateActions({
    repoRoot,
    cwd: repoRoot,
    baseActions: [
      {
        op: 'write',
        filePath: path.join(repoRoot, '.worktrees', '2026-08-07-sweep-the-leftovers', 'x.js'),
      },
    ],
  });
  assert.deepEqual(result, { ok: true });
});

test("cwd still wins when it's correct — the existing --background path is unaffected by the filePath fallback", () => {
  const repoRoot = tempRepoRoot();
  writePolicy(repoRoot, { level: 2 });
  const result = evaluateActions({
    repoRoot,
    cwd: path.join(repoRoot, '.worktrees', '2026-08-02-cage-the-coder'),
    baseActions: [{ op: 'exec', argv: ['git', 'push'] }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.layer, 'exec');
});

// A Bash call has no filePath to check. GLAFKA_TICKET_ID (below) fixes
// this for normal sessions. This test shows the small gap left over.
test('a Bash-only action with no filePath, a wrong cwd, AND no GLAFKA_TICKET_ID env is still unprotected (residual, narrower gap)', () => {
  const repoRoot = tempRepoRoot();
  writePolicy(repoRoot, { level: 2 });
  const previous = process.env.GLAFKA_TICKET_ID;
  delete process.env.GLAFKA_TICKET_ID;
  try {
    const result = evaluateActions({
      repoRoot,
      cwd: repoRoot,
      baseActions: [{ op: 'exec', argv: ['git', 'push'] }],
    });
    assert.deepEqual(result, { ok: true });
  } finally {
    if (previous === undefined) delete process.env.GLAFKA_TICKET_ID;
    else process.env.GLAFKA_TICKET_ID = previous;
  }
});

// --------------------------------------------------------------------------- evaluateActions — uses
// GLAFKA_TICKET_ID as a backup ticket id. This lets Bash calls with no file path still get checked correctly. ---------------------------------------------------------------------------

test('GLAFKA_TICKET_ID env cages a Bash-only action even with cwd = main checkout and no filePath in sight', () => {
  const repoRoot = tempRepoRoot();
  writePolicy(repoRoot, { level: 2 });
  const stateDir = path.join(repoRoot, '.glafka');
  makeTicket(stateDir, '2026-08-02-cage-the-coder');

  const previous = process.env.GLAFKA_TICKET_ID;
  process.env.GLAFKA_TICKET_ID = '2026-08-02-cage-the-coder';
  try {
    const result = evaluateActions({
      repoRoot,
      cwd: repoRoot, // stays the same — same issue as the subagent bug above
      baseActions: [{ op: 'exec', argv: ['git', 'push'] }],
    });
    assert.equal(result.ok, false);
    assert.equal(result.layer, 'exec');
  } finally {
    if (previous === undefined) delete process.env.GLAFKA_TICKET_ID;
    else process.env.GLAFKA_TICKET_ID = previous;
  }
});

test("GLAFKA_TICKET_ID env is ignored when it doesn't name a real ticket — cwd's own null still stands", () => {
  const repoRoot = tempRepoRoot();
  writePolicy(repoRoot, { level: 2 });
  // 2026-08-07-sweep-the-leftovers does not exist. It must not be trusted.

  const previous = process.env.GLAFKA_TICKET_ID;
  process.env.GLAFKA_TICKET_ID = '2026-08-07-sweep-the-leftovers';
  try {
    const result = evaluateActions({
      repoRoot,
      cwd: repoRoot,
      baseActions: [{ op: 'exec', argv: ['git', 'push'] }],
    });
    assert.deepEqual(result, { ok: true });
  } finally {
    if (previous === undefined) delete process.env.GLAFKA_TICKET_ID;
    else process.env.GLAFKA_TICKET_ID = previous;
  }
});

test('cwd still wins over GLAFKA_TICKET_ID when both are present — cwd stays the free, correct-first signal', () => {
  const repoRoot = tempRepoRoot();
  writePolicy(repoRoot, { level: 2 });
  const stateDir = path.join(repoRoot, '.glafka');
  makeTicket(stateDir, '2026-08-02-cage-the-coder');
  makeTicket(stateDir, '2026-08-02-cwd-wins-over-the-env');

  const previous = process.env.GLAFKA_TICKET_ID;
  // The env has a different ticket id — cwd must still win.
  process.env.GLAFKA_TICKET_ID = '2026-08-02-cwd-wins-over-the-env';
  try {
    const result = evaluateActions({
      repoRoot,
      cwd: path.join(repoRoot, '.worktrees', '2026-08-02-cage-the-coder'),
      baseActions: [{ op: 'exec', argv: ['git', 'push'] }],
    });
    assert.equal(result.ok, false);
    assert.equal(result.layer, 'exec');
  } finally {
    if (previous === undefined) delete process.env.GLAFKA_TICKET_ID;
    else process.env.GLAFKA_TICKET_ID = previous;
  }
});

// --------------------------------------------------------------------------- evaluateActions — full
// test for a real security bug found before ---------------------------------------------------------------------------

// A write that uses ".." to leave its worktree must still be denied.
// It must not be treated as having no ticket.
test("a write built to walk out of its own ticket's worktree is denied, not silently passed through as ticket-less", () => {
  const repoRoot = tempRepoRoot();
  writePolicy(repoRoot, { level: 2 });
  const stateDir = path.join(repoRoot, '.glafka');
  makeTicket(stateDir, '2026-08-02-cage-the-coder');

  const previous = process.env.GLAFKA_TICKET_ID;
  delete process.env.GLAFKA_TICKET_ID;
  try {
    const result = evaluateActions({
      repoRoot,
      // This is the main checkout, not the worktree. It must use filePath.
      cwd: repoRoot,
      baseActions: [
        {
          // This is a raw string, not path.join.
          // path.join would remove the ".." before we can check it.
          op: 'write',
          filePath: `${repoRoot}/.worktrees/2026-08-02-cage-the-coder/../../evil.js`,
        },
      ],
    });
    assert.equal(result.ok, false);
    assert.equal(result.layer, 'filesystem');
  } finally {
    if (previous === undefined) delete process.env.GLAFKA_TICKET_ID;
    else process.env.GLAFKA_TICKET_ID = previous;
  }
});

test('real end-to-end: a genuine ticket file, a Write inside its worktree, cwd at repoRoot — the whole chain resolves and allows', () => {
  const repoRoot = tempRepoRoot();
  writePolicy(repoRoot, { level: 3 });
  const stateDir = path.join(repoRoot, '.glafka');
  makeTicket(stateDir, '2026-08-02-cage-the-coder');

  const result = evaluateActions({
    repoRoot,
    cwd: repoRoot, // not the worktree — shows the filePath backup works
    baseActions: [
      {
        op: 'write',
        filePath: path.join(repoRoot, '.worktrees', '2026-08-02-cage-the-coder', 'src', 'x.js'),
      },
    ],
  });
  assert.deepEqual(result, { ok: true });
});

// --------------------------------------------------------------------------- Tests for bugs found before

// A real coder always has both signals: cwd inside .worktrees, and
// GLAFKA_TICKET_ID. If both are missing, it is a human — must stay allowed.
test('the human in the main checkout is allowed even while a ticket is open', () => {
  const repoRoot = tempRepoRoot();
  writePolicy(repoRoot, { level: 2 });
  makeTicket(path.join(repoRoot, '.glafka'), '2026-08-02-cage-the-coder');

  const previous = process.env.GLAFKA_TICKET_ID;
  delete process.env.GLAFKA_TICKET_ID;
  try {
    for (const action of [
      { op: 'read', filePath: path.join(repoRoot, 'README.md') } as Action,
      { op: 'exec', commandString: 'ls' } as Action,
    ]) {
      const result = evaluateActions({ repoRoot, cwd: repoRoot, baseActions: [action] });
      assert.deepEqual(result, { ok: true }, `${action.op} from the main checkout must be allowed`);
    }
  } finally {
    if (previous === undefined) delete process.env.GLAFKA_TICKET_ID;
    else process.env.GLAFKA_TICKET_ID = previous;
  }
});

// A path that names a worktree but has no real ticket is still a signal.
// It must still be denied.
test('a path naming an unknown ticket worktree is still refused', () => {
  const repoRoot = tempRepoRoot();
  writePolicy(repoRoot, { level: 2 });
  makeTicket(path.join(repoRoot, '.glafka'), '2026-08-02-cage-the-coder');

  const previous = process.env.GLAFKA_TICKET_ID;
  delete process.env.GLAFKA_TICKET_ID;
  try {
    const result = evaluateActions({
      repoRoot,
      cwd: repoRoot,
      baseActions: [
        {
          op: 'write',
          filePath: path.join(repoRoot, '.worktrees', '2026-08-02-a-ticket-never-created', 'x'),
        },
      ],
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.layer, 'core');
  } finally {
    if (previous === undefined) delete process.env.GLAFKA_TICKET_ID;
    else process.env.GLAFKA_TICKET_ID = previous;
  }
});

// Changing where <worktree>/.git points used to move repoRoot to a folder
// with no guardrails.json. That turns off every check (level 0).
function makeLinkedWorktree(repoRoot: string, id = '2026-08-02-cage-the-coder') {
  const worktree = path.join(repoRoot, '.worktrees', id);
  execFileSync('git', ['worktree', 'add', '-q', '-b', id, worktree], { cwd: repoRoot });
  return worktree;
}

test('a .git pointer that nothing points back at is refused, not followed', () => {
  const repoRoot = fs.realpathSync(makeGitRepo());
  const worktree = makeLinkedWorktree(repoRoot);
  assert.equal(findRepoRoot(worktree), repoRoot, 'the honest worktree must still resolve');

  const escape = fs.realpathSync(makeTempDir('escape'));
  fs.mkdirSync(path.join(escape, '.git'), { recursive: true });
  fs.writeFileSync(path.join(escape, '.git', 'commondir'), '.\n');
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(escape, '.git')}\n`);

  assert.throws(() => findRepoRoot(worktree), /does not point back at it|not registered under/);
});

test('a forged pointer that fakes the back-pointer is still not registered as a worktree', () => {
  const repoRoot = fs.realpathSync(makeGitRepo());
  const worktree = makeLinkedWorktree(repoRoot);
  const escape = fs.realpathSync(makeTempDir('escape'));
  fs.mkdirSync(path.join(escape, '.git'), { recursive: true });
  fs.writeFileSync(path.join(escape, '.git', 'commondir'), '.\n');
  fs.writeFileSync(path.join(escape, '.git', 'gitdir'), `${path.join(worktree, '.git')}\n`);
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(escape, '.git')}\n`);

  assert.throws(() => findRepoRoot(worktree), /not registered under/);
});

// The hook must block on this fake pointer.
// It must not fall back to allow-everything.
test('evaluateFromCwd denies rather than resolving level 0 through a forged pointer', () => {
  const repoRoot = fs.realpathSync(makeGitRepo());
  writePolicy(repoRoot, { level: 4 });
  const worktree = makeLinkedWorktree(repoRoot);
  const escape = fs.realpathSync(makeTempDir('escape'));
  fs.mkdirSync(path.join(escape, '.git'), { recursive: true });
  fs.writeFileSync(path.join(escape, '.git', 'commondir'), '.\n');
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(escape, '.git')}\n`);

  const result = evaluateFromCwd({
    cwd: worktree,
    baseActions: [{ op: 'read', filePath: path.join(os.homedir(), '.ssh', 'id_rsa') }],
  });
  assert.equal(result.ok, false);
});
