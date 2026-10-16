import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { install } from '../../src/commands/install/install.js';
import { runInstall } from '../../installKit/bin/commands/install.js';
import { CANDIDATE_CMD } from '../../src/commands/install/agentCandidates.js';
import { makeTempDir } from '../helpers/tempDir.js';
import { withoutAgentCmd } from '../helpers/noAgentEnv.js';

// These tests need no agent configured. Cleared here, so running this file directly is safe too.
withoutAgentCmd();

function tempDir() {
  return makeTempDir('install');
}

// bin/ and src/ live under dist/, the built output.
// This copies the built files, not the source.
function makeFakePackage() {
  const packageRoot = tempDir();
  fs.mkdirSync(path.join(packageRoot, 'dist', 'installKit', 'bin'), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, 'dist', 'installKit', 'bin', 'glafka.js'),
    '// fake CLI entry v1\n',
  );
  fs.mkdirSync(path.join(packageRoot, 'dist', 'src', 'commands'), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, 'dist', 'src', 'commands', 'genesis.js'),
    '// fake command\n',
  );
  fs.writeFileSync(
    path.join(packageRoot, 'package.json'),
    JSON.stringify({ name: 'glafka', type: 'module' }),
  );

  fs.mkdirSync(path.join(packageRoot, 'installKit', 'skills'), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, 'installKit', 'skills', 'genesis.md'),
    'genesis skill v1\n',
  );

  fs.mkdirSync(path.join(packageRoot, 'installKit', '.claude', 'commands', 'glafka'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(packageRoot, 'installKit', '.claude', 'commands', 'glafka', 'genesis.md'),
    'claude stub v1\n',
  );
  fs.mkdirSync(path.join(packageRoot, 'installKit', '.cursor', 'commands'), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, 'installKit', '.cursor', 'commands', 'glafka-genesis.md'),
    'cursor stub v1\n',
  );
  // This fake package is missing some platform folders on purpose.
  return packageRoot;
}

test('install vendors bin/, src/, and package.json into .glafka/', () => {
  const packageRoot = makeFakePackage();
  const targetRoot = tempDir();

  const { installed } = install({ packageRoot, targetRoot, platforms: ['claude'] });

  assert.ok(installed.includes('.glafka (vendored)'));
  assert.equal(
    fs.readFileSync(path.join(targetRoot, '.glafka', 'installKit', 'bin', 'glafka.js'), 'utf8'),
    '// fake CLI entry v1\n',
  );
  assert.equal(
    fs.readFileSync(path.join(targetRoot, '.glafka', 'src', 'commands', 'genesis.js'), 'utf8'),
    '// fake command\n',
  );
  const vendoredPkg = JSON.parse(
    fs.readFileSync(path.join(targetRoot, '.glafka', 'package.json'), 'utf8'),
  );
  assert.equal(vendoredPkg.type, 'module'); // needed so the copied code's import syntax works
});

// Every skill doc says `node .glafka/bin/glafka.js`. The real file sits a level
// deeper now, so that path has to keep resolving or every documented step breaks.
test('install leaves .glafka/bin/glafka.js working as the entry point', () => {
  const packageRoot = makeFakePackage();
  const targetRoot = tempDir();

  install({ packageRoot, targetRoot, platforms: ['claude'] });

  const shim = fs.readFileSync(path.join(targetRoot, '.glafka', 'bin', 'glafka.js'), 'utf8');
  assert.match(shim, /import '\.\.\/installKit\/bin\/glafka\.js'/);
  assert.ok(
    fs.existsSync(path.join(targetRoot, '.glafka', 'installKit', 'bin', 'glafka.js')),
    'the shim must point at a file that is really there',
  );
});

test('install creates .gitignore with .glafka/, .worktrees/, .env.glafka and .elaia/ when none exists yet', () => {
  const packageRoot = makeFakePackage();
  const targetRoot = tempDir();

  install({ packageRoot, targetRoot, platforms: ['claude'] });

  assert.equal(
    fs.readFileSync(path.join(targetRoot, '.gitignore'), 'utf8'),
    '.glafka/\n.worktrees/\n.env.glafka\n.elaia/\n',
  );
});

test('install appends its entries to an existing .gitignore without touching its content', () => {
  const packageRoot = makeFakePackage();
  const targetRoot = tempDir();
  fs.writeFileSync(path.join(targetRoot, '.gitignore'), 'node_modules/\n.env\n');

  install({ packageRoot, targetRoot, platforms: ['claude'] });

  assert.equal(
    fs.readFileSync(path.join(targetRoot, '.gitignore'), 'utf8'),
    'node_modules/\n.env\n.glafka/\n.worktrees/\n.env.glafka\n.elaia/\n',
  );
});

test('install only adds whichever entry is actually missing', () => {
  const packageRoot = makeFakePackage();
  const targetRoot = tempDir();
  fs.writeFileSync(path.join(targetRoot, '.gitignore'), 'node_modules/\n.glafka/\n');

  install({ packageRoot, targetRoot, platforms: ['claude'] });

  assert.equal(
    fs.readFileSync(path.join(targetRoot, '.gitignore'), 'utf8'),
    'node_modules/\n.glafka/\n.worktrees/\n.env.glafka\n.elaia/\n',
  );
});

test("install is idempotent about .gitignore — re-running doesn't duplicate any entry", () => {
  const packageRoot = makeFakePackage();
  const targetRoot = tempDir();

  install({ packageRoot, targetRoot, platforms: ['claude'] });
  install({ packageRoot, targetRoot, platforms: ['claude'] });

  const content = fs.readFileSync(path.join(targetRoot, '.gitignore'), 'utf8').split('\n');
  assert.equal(content.filter((l) => l.trim() === '.glafka/').length, 1);
  assert.equal(content.filter((l) => l.trim() === '.worktrees/').length, 1);
  assert.equal(content.filter((l) => l.trim() === '.env.glafka').length, 1);
});

test('install with no platforms given only installs claude, plus the shared skills', () => {
  const packageRoot = makeFakePackage();
  const targetRoot = tempDir();

  const { installed, platforms } = install({ packageRoot, targetRoot, platforms: ['claude'] });

  assert.deepEqual(
    installed.sort(),
    ['.claude', '.glafka (vendored)', 'docs/glafka/skills'].sort(),
  );
  assert.deepEqual(platforms, ['claude']);
  assert.equal(
    fs.readFileSync(path.join(targetRoot, 'docs', 'glafka', 'skills', 'genesis.md'), 'utf8'),
    'genesis skill v1\n',
  );
  assert.equal(
    fs.readFileSync(path.join(targetRoot, '.claude', 'commands', 'glafka', 'genesis.md'), 'utf8'),
    'claude stub v1\n',
  );
  assert.equal(fs.existsSync(path.join(targetRoot, '.cursor')), false);
});

test('install with an explicit platform list only installs those', () => {
  const packageRoot = makeFakePackage();
  const targetRoot = tempDir();

  const { installed, platforms } = install({ packageRoot, targetRoot, platforms: ['cursor'] });

  assert.ok(installed.includes('.cursor'));
  assert.deepEqual(platforms, ['cursor']);
  assert.equal(fs.existsSync(path.join(targetRoot, '.claude')), false);
  assert.equal(
    fs.readFileSync(path.join(targetRoot, '.cursor', 'commands', 'glafka-genesis.md'), 'utf8'),
    'cursor stub v1\n',
  );
});

test("install with 'all' installs every platform dir that exists in the package", () => {
  const packageRoot = makeFakePackage();
  const targetRoot = tempDir();

  const { installed, platforms } = install({ packageRoot, targetRoot, platforms: ['all'] });

  assert.ok(installed.includes('.claude'));
  assert.ok(installed.includes('.cursor'));
  // Some platform folders are missing on purpose.
  // Missing ones should not be listed as installed.
  assert.deepEqual(platforms.sort(), ['claude', 'cursor']);
});

// Old bug: this extra Kimi folder was not being copied.
// Uses a custom test package here, not the shared one.
test('install kimi also copies .kimi-code, the glafka-coder agent definition', () => {
  const packageRoot = tempDir();
  fs.mkdirSync(path.join(packageRoot, 'dist', 'installKit', 'bin'), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, 'dist', 'installKit', 'bin', 'glafka.js'),
    '// fake CLI entry\n',
  );
  fs.mkdirSync(path.join(packageRoot, 'dist', 'src', 'commands'), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, 'dist', 'src', 'commands', 'genesis.js'),
    '// fake command\n',
  );
  fs.writeFileSync(
    path.join(packageRoot, 'package.json'),
    JSON.stringify({ name: 'glafka', type: 'module' }),
  );
  fs.mkdirSync(path.join(packageRoot, 'installKit', '.kimi', 'skills'), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, 'installKit', '.kimi', 'skills', 'glafka-ergon.md'),
    'kimi skill stub\n',
  );
  fs.mkdirSync(path.join(packageRoot, 'installKit', '.kimi-code', 'agents'), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, 'installKit', '.kimi-code', 'agents', 'glafka-coder.yaml'),
    'agent stub\n',
  );

  const targetRoot = tempDir();
  const { installed } = install({ packageRoot, targetRoot, platforms: ['kimi'] });

  assert.ok(installed.includes('.kimi-code'));
  assert.equal(
    fs.readFileSync(path.join(targetRoot, '.kimi-code', 'agents', 'glafka-coder.yaml'), 'utf8'),
    'agent stub\n',
  );
  // Installing for claude should not copy another platform's folder.
  const otherTarget = tempDir();
  install({ packageRoot, targetRoot: otherTarget, platforms: ['claude'] });
  assert.equal(fs.existsSync(path.join(otherTarget, '.kimi-code')), false);
});

test('install rejects an unknown platform name with a clear error', () => {
  const packageRoot = makeFakePackage();
  const targetRoot = tempDir();

  assert.throws(
    () => install({ packageRoot, targetRoot, platforms: ['codex'] }),
    /unknown platform\(s\): codex/,
  );
});

test("install never touches the target's own unrelated files", () => {
  const packageRoot = makeFakePackage();
  const targetRoot = tempDir();
  fs.mkdirSync(path.join(targetRoot, '.claude', 'commands', 'other-tool'), { recursive: true });
  fs.writeFileSync(
    path.join(targetRoot, '.claude', 'commands', 'other-tool', 'foo.md'),
    "not glafka's\n",
  );

  install({ packageRoot, targetRoot, platforms: ['claude'] });

  assert.equal(
    fs.readFileSync(path.join(targetRoot, '.claude', 'commands', 'other-tool', 'foo.md'), 'utf8'),
    "not glafka's\n",
  );
});

test("re-running install re-stamps newer template content (the 'update' story)", () => {
  const packageRoot = makeFakePackage();
  const targetRoot = tempDir();

  install({ packageRoot, targetRoot, platforms: ['claude'] });
  fs.writeFileSync(
    path.join(packageRoot, 'installKit', '.claude', 'commands', 'glafka', 'genesis.md'),
    'claude stub v2\n',
  );
  fs.writeFileSync(
    path.join(packageRoot, 'dist', 'installKit', 'bin', 'glafka.js'),
    '// fake CLI entry v2\n',
  );
  install({ packageRoot, targetRoot, platforms: ['claude'] });

  assert.equal(
    fs.readFileSync(path.join(targetRoot, '.claude', 'commands', 'glafka', 'genesis.md'), 'utf8'),
    'claude stub v2\n',
  );
  assert.equal(
    fs.readFileSync(path.join(targetRoot, '.glafka', 'installKit', 'bin', 'glafka.js'), 'utf8'),
    '// fake CLI entry v2\n',
  );
});

// --------------------------------------------------------------------------- Old bug: install could
// overwrite the user's own CI workflow file. ---------------------------------------------------------------------------

// A fake package that looks like the real one, junk files included.
function makeFullPackage() {
  const packageRoot = makeFakePackage();
  fs.mkdirSync(path.join(packageRoot, 'installKit', '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, 'installKit', '.github', 'workflows', 'ci.yml'),
    'name: glafka CI\n',
  );
  fs.mkdirSync(path.join(packageRoot, 'installKit', '.github', 'skills', 'glafka-ergon'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(packageRoot, 'installKit', '.github', 'skills', 'glafka-ergon', 'SKILL.md'),
    'ergon skill v1\n',
  );
  fs.writeFileSync(path.join(packageRoot, 'installKit', '.github', '.DS_Store'), 'junk');
  return packageRoot;
}

test("install never replaces the project's own CI workflow", () => {
  const packageRoot = makeFullPackage();
  const targetRoot = tempDir();
  const workflow = path.join(targetRoot, '.github', 'workflows', 'ci.yml');
  fs.mkdirSync(path.dirname(workflow), { recursive: true });
  fs.writeFileSync(workflow, 'name: MY PROJECT CI (do not lose me)\n');

  install({ packageRoot, targetRoot, platforms: ['all'] });

  assert.equal(fs.readFileSync(workflow, 'utf8'), 'name: MY PROJECT CI (do not lose me)\n');
});

test('install does not create a workflow where the project had none', () => {
  const packageRoot = makeFullPackage();
  const targetRoot = tempDir();

  install({ packageRoot, targetRoot, platforms: ['all'] });

  assert.equal(
    fs.existsSync(path.join(targetRoot, '.github', 'workflows')),
    false,
    "glafka's CI is glafka's, not the project's",
  );
});

test('the github platform still installs its skills', () => {
  const packageRoot = makeFullPackage();
  const targetRoot = tempDir();

  install({ packageRoot, targetRoot, platforms: ['github'] });

  assert.equal(
    fs.readFileSync(path.join(targetRoot, '.github', 'skills', 'glafka-ergon', 'SKILL.md'), 'utf8'),
    'ergon skill v1\n',
  );
});

test('macOS junk files are not shipped into the project', () => {
  const packageRoot = makeFullPackage();
  const targetRoot = tempDir();

  install({ packageRoot, targetRoot, platforms: ['all'] });

  assert.equal(fs.existsSync(path.join(targetRoot, '.github', '.DS_Store')), false);
});

// Files glafka does not own should never be overwritten.
test('an existing file glafka does not own is skipped and reported, not overwritten', () => {
  const packageRoot = makeFakePackage();
  fs.writeFileSync(
    path.join(packageRoot, 'installKit', '.claude', 'settings.json'),
    '{"glafka":true}\n',
  );

  const targetRoot = tempDir();
  fs.mkdirSync(path.join(targetRoot, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(targetRoot, '.claude', 'settings.json'), '{"mine":true}\n');

  const { skipped } = install({ packageRoot, targetRoot, platforms: ['claude'] });

  assert.equal(
    fs.readFileSync(path.join(targetRoot, '.claude', 'settings.json'), 'utf8'),
    '{"mine":true}\n',
  );
  assert.ok(skipped.some((p) => p.endsWith(path.join('.claude', 'settings.json'))));
});

// glafka's own files should still update on upgrade.
test("glafka's own files are still overwritten on re-install", () => {
  const packageRoot = makeFakePackage();
  const targetRoot = tempDir();

  install({ packageRoot, targetRoot, platforms: ['claude'] });
  fs.writeFileSync(
    path.join(packageRoot, 'installKit', '.claude', 'commands', 'glafka', 'genesis.md'),
    'claude stub v2\n',
  );
  const { skipped } = install({ packageRoot, targetRoot, platforms: ['claude'] });

  assert.equal(
    fs.readFileSync(path.join(targetRoot, '.claude', 'commands', 'glafka', 'genesis.md'), 'utf8'),
    'claude stub v2\n',
  );
  assert.deepEqual(skipped, []);
});

// Which agent a project uses is the one thing glafka must not guess.
test('a bare `glafka install` refuses and lists the platforms, rather than picking one', () => {
  const targetRoot = tempDir();

  assert.throws(
    () => runInstall({ args: [], repoRoot: targetRoot, packageRoot: makeFakePackage() }),
    /usage: glafka install <platform>[\s\S]*claude[\s\S]*cursor/,
  );
  assert.equal(fs.existsSync(path.join(targetRoot, '.claude')), false);
  assert.equal(fs.existsSync(path.join(targetRoot, '.glafka')), false);
});

// The QA tester was the one role a default install left unset, so every round fell back to a
// person. It is probed and written the same way as the reviewer and the reporter.
test('install sets up agents.verifier, probed like the reporter', () => {
  const targetRoot = tempDir();
  const bin = tempDir();
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\ncat > /dev/null\necho GLAFKAOK\n', {
    mode: 0o755,
  });
  const previous = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previous ?? ''}`;
  const out: string[] = [];
  const { log } = console;
  console.log = (...a: unknown[]) => void out.push(a.join(' '));
  try {
    runInstall({
      // No 50 MB download in a test.
      args: ['claude', '--no-code-graph'],
      repoRoot: targetRoot,
      packageRoot: makeFakePackage(),
    });
  } finally {
    console.log = log;
    process.env.PATH = previous;
  }
  const config = JSON.parse(fs.readFileSync(path.join(targetRoot, '.glafka.json'), 'utf8'));
  assert.equal(config.agents.verifier, CANDIDATE_CMD.verifier!.claude);
  assert.match(out.join('\n'), /QA testing runs as its own process/);
});

// A fake `claude` on PATH that answers the probe and logs each call's flags.
function withFakeClaude<T>(fn: (calls: () => string[]) => T): T {
  const bin = tempDir();
  const log = path.join(bin, 'calls.log');
  const script = `#!/bin/sh\necho "$*" >> "${log}"\ncat > /dev/null\necho GLAFKAOK\n`;
  fs.writeFileSync(path.join(bin, 'claude'), script, { mode: 0o755 });
  const previous = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previous ?? ''}`;
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n') : []);
  try {
    return fn(calls);
  } finally {
    process.env.PATH = previous;
  }
}

function installQuietly(targetRoot: string): string {
  const out: string[] = [];
  const { log } = console;
  console.log = (...a: unknown[]) => void out.push(a.join(' '));
  try {
    runInstall({
      // No 50 MB download in a test.
      args: ['claude', '--no-code-graph'],
      repoRoot: targetRoot,
      packageRoot: makeFakePackage(),
    });
  } finally {
    console.log = log;
  }
  return out.join('\n');
}

const writeConfig = (targetRoot: string, agents: Record<string, string>) =>
  fs.writeFileSync(path.join(targetRoot, '.glafka.json'), JSON.stringify({ agents }));
const readAgents = (targetRoot: string) =>
  JSON.parse(fs.readFileSync(path.join(targetRoot, '.glafka.json'), 'utf8')).agents;

// M10: a probe is a paid run of up to 90 s. A verifier already set needs none.
test('install does not probe a verifier when agents.verifier is already set', () => {
  const targetRoot = tempDir();
  writeConfig(targetRoot, { verifier: 'my-verifier' });
  withFakeClaude((calls) => {
    const out = installQuietly(targetRoot);
    assert.equal(calls().filter((c) => c.includes('--disallowedTools')).length, 0);
    assert.match(out, /a verifier is already configured/);
  });
  assert.equal(readAgents(targetRoot).verifier, 'my-verifier');
});

// M10: agents.verifier would override the default the project relies on.
test('install writes no agents.verifier over agents.default, and says why', () => {
  const targetRoot = tempDir();
  writeConfig(targetRoot, { default: 'my-agent -p' });
  const out = withFakeClaude(() => installQuietly(targetRoot));
  assert.equal(readAgents(targetRoot).verifier, undefined);
  assert.match(out, /agents\.verifier not written — the QA tester uses agents\.default/);
});

test('install writes no agents.verifier while GLAFKA_AGENT_CMD is set, and says why', () => {
  const targetRoot = tempDir();
  const previous = process.env.GLAFKA_AGENT_CMD;
  process.env.GLAFKA_AGENT_CMD = 'my-agent -p';
  try {
    const out = withFakeClaude(() => installQuietly(targetRoot));
    assert.equal(readAgents(targetRoot).verifier, undefined);
    assert.match(out, /agents\.verifier not written — the QA tester uses GLAFKA_AGENT_CMD/);
  } finally {
    if (previous === undefined) delete process.env.GLAFKA_AGENT_CMD;
    else process.env.GLAFKA_AGENT_CMD = previous;
  }
});
