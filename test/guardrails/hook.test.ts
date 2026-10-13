import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeGitRepo } from '../helpers/gitFixture.js';
import { ticketFiles, ticketsDir } from '../../src/ticket/paths.js';

// hook.ts checks a tool before it runs. Silence means "allowed", so it must never go silent by
// accident. This runs the real built file. Run `npm run build` first.

const HOOK = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'dist',
  'installKit',
  'guardrails',
  'hooks',
  'hook.js',
);

// `cwd` here is the hook process's own folder, not the payload's `cwd`.
// A past bug happened when these two did not match.
function runHookIn(stdin: string, cwd?: string): { out: string; code: number } {
  try {
    const out = execFileSync('node', [HOOK], { input: stdin, encoding: 'utf8', cwd });
    return { out, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { out: `${e.stdout ?? ''}${e.stderr ?? ''}`, code: e.status ?? 1 };
  }
}

function runHook(stdin: string): { out: string; code: number } {
  return runHookIn(stdin);
}

// Bug: `JSON.parse("null")` works fine, so bad input slipped through.
// Now the code checks the payload is really an object, and blocks it.
test("a payload that parses but isn't an object (JSON `null`) is denied, not a silent crash", () => {
  const result = runHook('null');
  assert.equal(result.code, 2);
  const decision = JSON.parse(result.out.split('\n')[0]);
  assert.equal(decision.decision, 'block');
});

test('normal input still passes through unharmed', () => {
  const payload = JSON.stringify({
    tool_name: 'Read',
    tool_input: { file_path: 'README.md' },
    cwd: process.cwd(),
  });
  const result = runHook(payload);
  assert.equal(result.code, 0);
});

// --- Regressions: test the real hook's exit code and decision ---

// Sets up a real repo, worktree, ticket file, and policy file.
// Nothing is faked. The hook checks all of it for real.
function makeCagedRepo(level: number): { repoRoot: string; worktree: string; id: string } {
  const repoRoot = fs.realpathSync(makeGitRepo());
  const id = '2026-08-02-cage-the-coder';

  const policyFile = path.join(repoRoot, 'docs', 'glafka', 'guardrails.json');
  fs.mkdirSync(path.dirname(policyFile), { recursive: true });
  fs.writeFileSync(policyFile, JSON.stringify({ level }));

  const { ticketFile } = ticketFiles(ticketsDir(path.join(repoRoot, '.glafka')), id);
  fs.mkdirSync(path.dirname(ticketFile), { recursive: true });
  fs.writeFileSync(ticketFile, '{}');

  const worktree = path.join(repoRoot, '.worktrees', id);
  execFileSync('git', ['worktree', 'add', '-q', '-b', id, worktree], { cwd: repoRoot });
  return { repoRoot, worktree, id };
}

function hookCall(
  toolName: string,
  toolInput: Record<string, unknown>,
  cwd: string,
): { out: string; code: number } {
  return runHook(JSON.stringify({ tool_name: toolName, tool_input: toolInput, cwd }));
}

// Old bug: a bad file path turned into an empty string and got allowed.
// This must always be blocked, even at the strictest safety level.
test('a write whose file_path is not a string is denied, not waved through', () => {
  const { worktree } = makeCagedRepo(4);
  const target = '/etc/cron.d/pwn';

  // Control check: the same write, as normal text, is blocked.
  assert.equal(hookCall('Write', { file_path: target, content: 'x' }, worktree).code, 2);

  for (const badPath of [[target], 42, { path: target }, null]) {
    for (const tool of ['Write', 'Edit']) {
      const result = hookCall(tool, { file_path: badPath, content: 'x' }, worktree);
      assert.equal(result.code, 2, `${tool} with file_path=${JSON.stringify(badPath)}`);
    }
  }
});

test('a write with a real path inside the worktree still passes', () => {
  const { worktree } = makeCagedRepo(4);
  const result = hookCall(
    'Write',
    { file_path: path.join(worktree, 'src', 'ok.ts'), content: 'x' },
    worktree,
  );
  assert.equal(result.code, 0);
});

// Old bug: the code did not read the right field for the path.
// So it missed the check and let a risky command through.
test('Glob with an absolute pattern and no path is denied', () => {
  const { worktree } = makeCagedRepo(4);
  const outside = path.join(os.homedir(), '.ssh', '*');

  // Control check: same target, but using the field that works.
  assert.equal(hookCall('Glob', { path: path.join(os.homedir(), '.ssh') }, worktree).code, 2);
  assert.equal(hookCall('Glob', { pattern: outside }, worktree).code, 2);
});

test('Grep with an absolute glob outside the worktree is denied', () => {
  const { worktree } = makeCagedRepo(4);
  const result = hookCall(
    'Grep',
    { pattern: 'BEGIN RSA', glob: path.join(os.homedir(), '.ssh', '**') },
    worktree,
  );
  assert.equal(result.code, 2);
});

// A normal relative path must still work.
// It is checked against the worktree, not where the hook runs.
test('an ordinary relative Glob inside the worktree still passes', () => {
  const { worktree } = makeCagedRepo(4);
  assert.equal(hookCall('Glob', { pattern: 'src/**/*.ts' }, worktree).code, 0);
  assert.equal(hookCall('Grep', { pattern: 'TODO', glob: '*.ts' }, worktree).code, 0);
});

// Old bug: the code used the wrong folder to check a path.
// So the same input was sometimes allowed, sometimes blocked, by mistake.
test('a relative path is judged against the payload cwd, not the hook process cwd', () => {
  const { repoRoot, worktree } = makeCagedRepo(4);

  // The hook process runs from the main folder, not the worktree.
  const fromMain = runHookIn(
    JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'src/ok.ts' }, cwd: worktree }),
    repoRoot,
  );
  const fromWorktree = runHookIn(
    JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'src/ok.ts' }, cwd: worktree }),
    worktree,
  );
  assert.equal(fromMain.code, fromWorktree.code, 'the answer must not depend on the hook cwd');
  assert.equal(fromMain.code, 0);
});

// Old bug: some safe, harmless tools were treated as unknown and blocked.
// Tools like BashOutput and Skill are needed and should be allowed.
for (const level of [3, 4]) {
  test(`level ${level}: inert harness tools are not refused`, () => {
    const { worktree } = makeCagedRepo(level);
    for (const tool of ['TodoWrite', 'BashOutput', 'KillShell', 'ExitPlanMode']) {
      assert.equal(hookCall(tool, {}, worktree).code, 0, tool);
    }
  });

  test(`level ${level}: genuinely unknown tools are still denied`, () => {
    const { worktree } = makeCagedRepo(level);
    for (const tool of ['mcp__foo__bar', 'SomethingNobodyModelled']) {
      assert.equal(hookCall(tool, {}, worktree).code, 2, tool);
    }
  });
}

// WebFetch reaches the internet, so it must be checked, not ignored.
// It used to pass through unchecked at a lower safety level.
test('level 4 denies WebFetch, which allows no network at all', () => {
  const { worktree } = makeCagedRepo(4);
  assert.equal(hookCall('WebFetch', { url: 'https://example.com' }, worktree).code, 2);
});

// A normal search command must work at the usual safety level.
// It must also work at the strictest safety level.
for (const level of [2, 4]) {
  test(`level ${level}: a plain Grep with only a search term is allowed`, () => {
    const { worktree } = makeCagedRepo(level);
    assert.equal(hookCall('Grep', { pattern: 'TODO' }, worktree).code, 0);
    assert.equal(hookCall('Glob', { pattern: '**/*.ts' }, worktree).code, 0);
  });
}

// An outside tool with a path outside the worktree must be blocked.
// It used to slip past the file safety check by mistake.
test('level 2: an MCP write outside the worktree is refused', () => {
  const { worktree } = makeCagedRepo(2);
  const result = hookCall(
    'mcp__filesystem__write_file',
    { path: path.join(os.homedir(), '.ssh', 'id_rsa'), contents: 'x' },
    worktree,
  );
  assert.equal(result.code, 2);
});

test('level 2: an MCP tool writing inside the worktree is still allowed', () => {
  const { worktree } = makeCagedRepo(2);
  const result = hookCall(
    'mcp__filesystem__write_file',
    { path: path.join(worktree, 'src', 'ok.ts'), contents: 'x' },
    worktree,
  );
  assert.equal(result.code, 0);
});

test('levels 3 and 4 still deny every MCP tool outright', () => {
  for (const level of [3, 4]) {
    const { worktree } = makeCagedRepo(level);
    assert.equal(hookCall('mcp__postgres__query', { sql: 'select 1' }, worktree).code, 2);
  }
});
