import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from '../helpers/tempDir.js';

// The hook decides every tool call an agent makes, and it fails CLOSED: one that cannot load denies
// everything, which takes the whole agent down rather than weakening it. That is exactly what
// happened when the built adapters moved under dist/installKit/ and the dispatcher kept looking in
// dist/ — every unit test passed, because none of them ran the real hook out of a real install.
//
// So this one installs glafka for real and talks to the hook the way an agent does: a JSON payload
// on stdin, a decision on stdout. Slow, and listed in SLOW_SUITES for it.

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUILT_CLI = path.join(REPO_ROOT, 'dist', 'installKit', 'bin', 'glafka.js');

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

// A real project with glafka installed into it, exactly as a person would.
function installedProject(): string {
  const repoRoot = fs.realpathSync(makeTempDir('vendored-hook'));
  git(repoRoot, 'init', '-q', '-b', 'main', '.');
  git(repoRoot, 'config', 'user.email', 'test@example.com');
  git(repoRoot, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(repoRoot, 'package.json'), '{"name":"demo"}\n');
  git(repoRoot, 'add', '-A');
  git(repoRoot, 'commit', '-q', '-m', 'init');

  // --all would probe a reviewer command for every platform, which costs real LLM calls.
  // No code graph: a test must not download it into the real home folder.
  execFileSync('node', [BUILT_CLI, 'install', 'gemini', '--no-code-graph'], {
    cwd: repoRoot,
    stdio: 'ignore',
  });
  return repoRoot;
}

// A ticket with a real worktree, which is what "outside the worktree" is measured against.
function ticketWithWorktree(repoRoot: string): { id: string; worktree: string } {
  const id = execFileSync('node', [BUILT_CLI, 'create', 'add a widget'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .trim()
    .split(/\s+/)[0]!;

  const specPath = path.join(repoRoot, 'spec.md');
  const planPath = path.join(repoRoot, 'plan.md');
  fs.writeFileSync(specPath, '# spec\nadd a widget\n');
  fs.writeFileSync(planPath, '1. add the widget\n');
  execFileSync('node', [BUILT_CLI, 'spec', id, specPath, '--title', 'add a widget'], {
    cwd: repoRoot,
    stdio: 'ignore',
  });
  execFileSync('node', [BUILT_CLI, 'plan', id, planPath], { cwd: repoRoot, stdio: 'ignore' });
  return { id, worktree: path.join(repoRoot, '.worktrees', id) };
}

// Speaks to the hook the way the agent's harness does. GLAFKA_TICKET_ID is how a spawned coder is
// identified; without a ticket the hook cannot tell an agent from the person at the keyboard, and
// deliberately skips every layer rather than cage the human.
function hookCall(
  repoRoot: string,
  payload: unknown,
  ticketId: string | null = null,
): { code: number | null; decision: string | null } {
  const result = spawnSync(
    'node',
    [path.join(repoRoot, '.glafka', 'bin', 'glafka.js'), 'guardrails', '--run-hook', 'claude'],
    {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      cwd: repoRoot,
      env: ticketId ? { ...process.env, GLAFKA_TICKET_ID: ticketId } : process.env,
    },
  );
  let decision: string | null = null;
  for (const line of (result.stdout ?? '').split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    try {
      decision = (JSON.parse(line) as { decision?: string }).decision ?? null;
    } catch {
      // Not every line is ours to read.
    }
  }
  return { code: result.status, decision };
}

// The bug this file exists for. A dispatcher that cannot find its adapter denies, so the symptom
// was every tool call refused — and nothing before this ran the vendored hook to see it.
test('the vendored hook loads and allows an ordinary call', () => {
  const repoRoot = installedProject();

  const { code, decision } = hookCall(repoRoot, {
    tool_name: 'Read',
    tool_input: { file_path: path.join(repoRoot, 'package.json') },
    cwd: repoRoot,
  });

  assert.equal(code, 0, 'an ordinary read must not be refused');
  assert.notEqual(decision, 'block', 'the hook denied a read it should have allowed');
});

// Allowing is only half the proof. A hook that loaded but enforced nothing would pass the test
// above, and so would one that had been silently disabled — this is what tells them apart.
test('the vendored hook really enforces, once the project turns it on', () => {
  const repoRoot = installedProject();
  // The file is the switch. `glafka guardrails --level 2` writes this same file.
  fs.mkdirSync(path.join(repoRoot, 'docs', 'glafka'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'docs', 'glafka', 'guardrails.json'), '{ "level": 2 }\n');
  const { id, worktree } = ticketWithWorktree(repoRoot);

  const outside = hookCall(
    repoRoot,
    {
      tool_name: 'Write',
      tool_input: { file_path: path.join(repoRoot, 'escaped.txt'), content: 'x' },
      cwd: worktree,
    },
    id,
  );

  assert.equal(outside.decision, 'block', 'a write outside the worktree must be refused');
  assert.equal(outside.code, 2, 'a refusal is exit 2, which is what the harness reads');

  // And it is really the LAYER answering, not a hook that blocks whatever it is sent.
  const inside = hookCall(
    repoRoot,
    {
      tool_name: 'Write',
      tool_input: { file_path: path.join(worktree, 'widget.js'), content: 'x' },
      cwd: worktree,
    },
    id,
  );

  assert.notEqual(inside.decision, 'block', 'a write inside the worktree must still be allowed');
});
