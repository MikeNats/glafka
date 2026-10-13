import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeGitRepo } from '../helpers/gitFixture.js';
import { genesis } from '../../src/commands/genesis/genesis.js';
import { installAllHooks, installOpenCodeHook } from '../../installKit/bin/hooks/install.js';
import { makeTempDir } from '../helpers/tempDir.js';

// --install-hook must commit the hook files, not just write them.
// A new ticket checkout only sees committed files.

// Runs the built code, not the source files. Run "npm run build" first.
const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const BIN = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'dist',
  'installKit',
  'bin',
  'glafka.js',
);

function runGuardrails(repoRoot: string, args: string[]): { out: string; code: number } {
  try {
    const out = execFileSync('node', [BIN, 'guardrails', ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    return { out, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { out: `${e.stdout ?? ''}${e.stderr ?? ''}`, code: e.status ?? 1 };
  }
}

function headSha(repoRoot: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
}

test(
  "--install-hook commits the config so a ticket's worktree actually has it",
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();

    const { out, code } = runGuardrails(repoRoot, ['--install-hook']);
    assert.equal(code, 0);
    assert.match(out, /committed [0-9a-f]{7}/);

    const ticket = await genesis({
      repoRoot,
      stateDir: path.join(repoRoot, '.glafka'),
      content: 'task',
    });

    assert.equal(
      fs.existsSync(path.join(ticket.worktree!, '.claude', 'settings.json')),
      true,
      "the hook config must be committed content, not just sitting in repoRoot's working tree",
    );
  },
);

// --install-hook must only run on the base branch (like main).
// Running it on another branch would silently break new tickets.
test('--install-hook refuses to run on a branch other than baseRef', () => {
  const repoRoot = makeGitRepo();
  execFileSync('git', ['checkout', '-q', '-b', 'feature/my-work'], { cwd: repoRoot });
  const before = headSha(repoRoot);

  const { out, code } = runGuardrails(repoRoot, ['--install-hook']);

  assert.notEqual(code, 0);
  assert.match(out, /must run on main.*not feature\/my-work/s);
  assert.equal(
    fs.existsSync(path.join(repoRoot, '.claude', 'settings.json')),
    false,
    'must not write hook config while refusing',
  );
  assert.equal(headSha(repoRoot), before, 'no install commit landed on the feature branch either');
});

test('running --install-hook again reports already installed and makes no new commit', () => {
  const repoRoot = makeGitRepo();
  runGuardrails(repoRoot, ['--install-hook']);
  const before = headSha(repoRoot);

  const { out } = runGuardrails(repoRoot, ['--install-hook']);

  assert.match(out, /already installed/);
  assert.equal(headSha(repoRoot), before);
});

// The matcher must catch every tool, not just a hand-picked list.
// A named list can miss new tools by mistake.
test('--install-hook writes a catch-all matcher, not a hand-listed tool set', () => {
  const repoRoot = makeGitRepo();
  runGuardrails(repoRoot, ['--install-hook']);

  const claudeSettings = JSON.parse(
    fs.readFileSync(path.join(repoRoot, '.claude', 'settings.json'), 'utf8'),
  );
  assert.equal(claudeSettings.hooks.PreToolUse[0].matcher, '*');

  const geminiSettings = JSON.parse(
    fs.readFileSync(path.join(repoRoot, '.gemini', 'settings.json'), 'utf8'),
  );
  assert.equal(geminiSettings.hooks.BeforeTool[0].matcher, '*');
});

// The committed command must not have a machine-specific path.
// A teammate or CI has glafka installed somewhere else.
test('--install-hook commits a portable command, not a machine-absolute path', () => {
  const repoRoot = makeGitRepo();
  runGuardrails(repoRoot, ['--install-hook']);

  const claudeSettings = JSON.parse(
    fs.readFileSync(path.join(repoRoot, '.claude', 'settings.json'), 'utf8'),
  );
  const claudeCommand = claudeSettings.hooks.PreToolUse[0].hooks[0].command;
  assert.equal(claudeCommand, 'glafka guardrails --run-hook claude');
  assert.ok(!claudeCommand.includes(repoRoot), "must not embed this machine's own filesystem path");

  const geminiSettings = JSON.parse(
    fs.readFileSync(path.join(repoRoot, '.gemini', 'settings.json'), 'utf8'),
  );
  assert.equal(
    geminiSettings.hooks.BeforeTool[0].hooks[0].command,
    'glafka guardrails --run-hook gemini',
  );

  const cursorSettings = JSON.parse(
    fs.readFileSync(path.join(repoRoot, '.cursor', 'hooks.json'), 'utf8'),
  );
  assert.equal(
    cursorSettings.hooks.beforeShellExecution[0].command,
    'glafka guardrails --run-hook cursor',
  );
});

// The command it now points to must actually work.
// It must give the same result as the old direct call did.
test('--run-hook claude dispatches to the real guardrails decision', () => {
  const repoRoot = makeGitRepo();
  fs.mkdirSync(path.join(repoRoot, 'docs', 'glafka'), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, 'docs', 'glafka', 'guardrails.json'),
    JSON.stringify({ level: 2 }),
  );
  const worktree = path.join(repoRoot, '.worktrees', '2026-08-02-cage-the-coder');
  fs.mkdirSync(worktree, { recursive: true });

  const payload = JSON.stringify({
    tool_name: 'Bash',
    tool_input: { command: 'git push' },
    cwd: worktree,
  });

  let threw = false;
  try {
    execFileSync('node', [BIN, 'guardrails', '--run-hook', 'claude'], {
      input: payload,
      encoding: 'utf8',
    });
  } catch (err) {
    threw = true;
    const e = err as { status?: number; stdout?: string };
    assert.equal(e.status, 2);
    assert.match(e.stdout ?? '', /"decision":"block"/);
  }
  assert.ok(threw, 'a never-allowed command must still be denied through the run-hook shim');
});

test('--install-hook does not touch other work already staged for commit', () => {
  const repoRoot = makeGitRepo();
  fs.writeFileSync(path.join(repoRoot, 'wip.txt'), 'unrelated in-progress work\n');
  execFileSync('git', ['add', 'wip.txt'], { cwd: repoRoot });

  runGuardrails(repoRoot, ['--install-hook']);

  const status = execFileSync('git', ['status', '--porcelain'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.match(
    status,
    /^A {2}wip\.txt$/m,
    'wip.txt must remain staged, untouched by the hook commit',
  );
});

// --------------------------------------------------------------------------- Older bug fixes, tested
// below. ---------------------------------------------------------------------------

// Running install many times must not add duplicate hooks.
// An old hook with a wrong path must be replaced, not kept.
function kimiBlocks(configPath: string): string[] {
  if (!fs.existsSync(configPath)) return [];
  return fs
    .readFileSync(configPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().startsWith('command ='));
}

function withFakeHome<T>(fn: (home: string) => T): T {
  const home = makeTempDir('home');
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn(home);
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  }
}

test('installing twice from the same path leaves exactly one global kimi hook', () => {
  withFakeHome((home) => {
    const repoRoot = makeTempDir('repo');
    const config = path.join(home, '.kimi-code', 'config.toml');

    installAllHooks(repoRoot, REPO_ROOT);
    installAllHooks(repoRoot, REPO_ROOT);
    installAllHooks(repoRoot, REPO_ROOT);

    assert.equal(kimiBlocks(config).length, 1);
  });
});

test('the second run reports it was already installed', () => {
  withFakeHome(() => {
    const repoRoot = makeTempDir('repo');
    installAllHooks(repoRoot, REPO_ROOT);
    const second = installAllHooks(repoRoot, REPO_ROOT);
    const kimi = second.find((o) => o.name.startsWith('Kimi'));
    assert.equal(kimi?.already, true);
    assert.equal(kimi?.error, null);
  });
});

test('reinstalling from a different path replaces the block, it does not add one', () => {
  withFakeHome((home) => {
    const repoRoot = makeTempDir('repo');
    const config = path.join(home, '.kimi-code', 'config.toml');
    const otherRoot = makeTempDir('v2');

    installAllHooks(repoRoot, REPO_ROOT);
    installAllHooks(repoRoot, otherRoot);

    const blocks = kimiBlocks(config);
    assert.equal(blocks.length, 1, 'the stale block must be gone, not left behind');
    assert.ok(blocks[0].includes(otherRoot), 'and the surviving one must be the new path');
  });
});

test("another tool's hooks in the same global config are left alone", () => {
  withFakeHome((home) => {
    const repoRoot = makeTempDir('repo');
    const config = path.join(home, '.kimi-code', 'config.toml');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(
      config,
      'model = "kimi-k2"\n\n[[hooks]]\nevent = "PreToolUse"\ncommand = "some-other-tool"\n',
    );

    installAllHooks(repoRoot, REPO_ROOT);
    installAllHooks(repoRoot, REPO_ROOT);

    const text = fs.readFileSync(config, 'utf8');
    assert.match(text, /model = "kimi-k2"/);
    assert.match(text, /some-other-tool/);
    assert.equal(kimiBlocks(config).filter((l) => l.includes('hook-kimi.js')).length, 1);
  });
});

// The committed hook file must not have an absolute path.
// An absolute path would break on a different machine.
test('the committed opencode shim contains no absolute install path', () => {
  const repoRoot = makeTempDir('opencode-abs');
  fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({ type: 'module' }));

  const { filePath } = installOpenCodeHook(repoRoot);
  const content = fs.readFileSync(filePath, 'utf8');

  assert.doesNotMatch(content, /file:\/\//, 'no absolute file:// URL');
  assert.ok(!content.includes(REPO_ROOT), 'and no absolute install path at all');
  assert.ok(!content.includes(os.homedir()), 'and nothing naming this machine');
});

test('the same shim is produced from two different install paths', () => {
  const a = makeTempDir('oc-a');
  const b = makeTempDir('oc-b');
  for (const dir of [a, b]) {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  }

  const first = fs.readFileSync(installOpenCodeHook(a).filePath, 'utf8');
  const second = fs.readFileSync(installOpenCodeHook(b).filePath, 'utf8');

  assert.equal(first, second, 'the pinned guardrails hash must not encode the install path');
});

// Copilot reads every .json file under .github/hooks/, so ours must land
// there, be idempotent, and leave any other file in that folder alone.
test('copilot: hook lands in .github/hooks/ and a second run adds nothing', () => {
  const repoRoot = makeTempDir('copilot');
  const filePath = path.join(repoRoot, '.github', 'hooks', 'glafka-guardrails.json');

  installAllHooks(repoRoot, REPO_ROOT);
  const first = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(first.hooks.preToolUse.length, 1);
  assert.equal(first.hooks.preToolUse[0].command, 'glafka guardrails --run-hook copilot');
  // No matcher on purpose: an omitted matcher means every tool.
  assert.equal(first.hooks.preToolUse[0].matcher, undefined);

  const second = installAllHooks(repoRoot, REPO_ROOT).find((o) => o.name.startsWith('GitHub'));
  assert.equal(second?.already, true);
  assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).hooks.preToolUse.length, 1);
});

test('copilot: another hook file in .github/hooks/ is left alone', () => {
  const repoRoot = makeTempDir('copilot');
  const theirs = path.join(repoRoot, '.github', 'hooks', 'their-policy.json');
  fs.mkdirSync(path.dirname(theirs), { recursive: true });
  fs.writeFileSync(theirs, '{"version":1,"hooks":{"sessionStart":[]}}\n');

  installAllHooks(repoRoot, REPO_ROOT);

  assert.equal(fs.readFileSync(theirs, 'utf8'), '{"version":1,"hooks":{"sessionStart":[]}}\n');
});
