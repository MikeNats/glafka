import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { install } from '../../src/commands/install/install.js';
import { hygeia, NotAnNpmProjectError } from '../../src/commands/hygeia/hygeia.js';
import { loadConfig, noAgentCmd } from '../../src/config.js';
import { readTicket, recordStage, describeTicket, STAGES } from '../../src/ticket/ticketStore.js';
import type { Stage } from '../../src/types/ticket.js';
import { createTicket } from '../../src/commands/genesis/genesis.js';
import { uncommittedPaths, findRepoRoot } from '../../src/util/git.js';
import { LAYER_NAMES } from '../../installKit/guardrails/explain.js';
import { listPersonas, loadPersonaContent, setActivePersona } from '../../src/memory/persona.js';
import { projectPersonasDir } from '../../src/memory/docsStore.js';
import { makeGitRepo } from '../helpers/gitFixture.js';
import { makeTempDir } from '../helpers/tempDir.js';

// Regression tests. Each one fails if its fix is reverted.

function tempDir(prefix: string): string {
  return makeTempDir(prefix);
}

// ---------------------------------------------------------------------------

// The vendored copy imports zod by bare name. Without it inside .glafka/, every command in a project
// that does not itself depend on zod died with ERR_MODULE_NOT_FOUND — which is every command in the tool.
test('install vendors the runtime dependencies into .glafka/node_modules', () => {
  const targetRoot = tempDir('vendor-target');
  const packageRoot = path.resolve(import.meta.dirname, '../..');

  const result = install({ packageRoot, targetRoot, platforms: [] });

  assert.deepEqual(result.missingDependencies, []);
  const zod = path.join(targetRoot, '.glafka', 'node_modules', 'zod');
  assert.equal(fs.existsSync(zod), true, 'zod must be vendored beside the CLI');
  assert.equal(fs.existsSync(path.join(zod, 'package.json')), true);
});

// A dependency it could not find must be reported, not swallowed: the install
// otherwise looks like it worked and no command runs.
test('install reports a dependency it could not vendor instead of failing silently', () => {
  const packageRoot = tempDir('vendor-pkg');
  const targetRoot = tempDir('vendor-target2');
  fs.mkdirSync(path.join(packageRoot, 'dist', 'installKit', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'dist', 'installKit', 'bin', 'glafka.js'), '// cli\n');
  fs.mkdirSync(path.join(packageRoot, 'dist', 'src'), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'dist', 'src', 'x.js'), '// src\n');
  fs.writeFileSync(
    path.join(packageRoot, 'package.json'),
    JSON.stringify({ name: 'glafka', version: '0.0.0', type: 'module' }),
  );

  const result = install({ packageRoot, targetRoot, platforms: [] });

  assert.deepEqual(result.missingDependencies, ['zod']);
});

// ---------------------------------------------------------------------------

// README told people to type `/glafka:cancel`, and no platform shipped it. Every skill doc must have
// a command on every platform, or the documented flow has steps you cannot reach from a session.
test('every skill ships a slash command on every platform', () => {
  const packageRoot = path.resolve(import.meta.dirname, '../..');
  const skills = fs
    .readdirSync(path.join(packageRoot, 'installKit', 'skills'))
    .filter((name) => name.endsWith('.md'))
    .map((name) => name.replace(/\.md$/, ''));

  const layouts: [string, (skill: string) => string][] = [
    ['claude', (s) => `.claude/commands/glafka/${s}.md`],
    ['cursor', (s) => `.cursor/commands/glafka-${s}.md`],
    ['opencode', (s) => `.opencode/commands/glafka-${s}.md`],
    ['gemini', (s) => `.gemini/commands/glafka/${s}.toml`],
    ['kimi', (s) => `.kimi/skills/glafka-${s}/SKILL.md`],
    ['github', (s) => `.github/skills/glafka-${s}/SKILL.md`],
  ];

  const missing: string[] = [];
  for (const skill of skills) {
    for (const [platform, layout] of layouts) {
      if (!fs.existsSync(path.join(packageRoot, 'installKit', layout(skill)))) {
        missing.push(`${platform}:${skill}`);
      }
    }
  }
  assert.deepEqual(missing, [], `no command for: ${missing.join(', ')}`);
});

// The skills all invoke `node .glafka/bin/glafka.js`, which `Bash(glafka:*)`
// never matches — so the allowlist covered none of the real calls.
test("Claude's allowed-tools cover the invocation the skills actually use", () => {
  const dir = path.resolve(import.meta.dirname, '../../installKit/.claude/commands/glafka');
  for (const name of fs.readdirSync(dir)) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    assert.ok(
      text.includes('Bash(node .glafka/bin/glafka.js:*)'),
      `${name} must allow the vendored invocation`,
    );
  }
});

// ---------------------------------------------------------------------------

// `npm audit` in a directory with no manifest succeeds and prints
// "found 0 vulnerabilities" — a clean bill of health for a tree it never read.
test('hygeia refuses a project with no package.json instead of reporting it clean', () => {
  const cwd = tempDir('hygeia');
  let ran = false;
  assert.throws(
    () =>
      hygeia({
        cwd,
        run: () => {
          ran = true;
          return '';
        },
      }),
    NotAnNpmProjectError,
  );
  assert.equal(ran, false, 'npm must not run at all');
});

test('hygeia still runs where there is a package.json', () => {
  const cwd = tempDir('hygeia-npm');
  fs.writeFileSync(path.join(cwd, 'package.json'), '{"name":"x"}');
  const calls: string[][] = [];
  const result = hygeia({
    cwd,
    run: (_file, args) => {
      calls.push([...args]);
      return 'ok';
    },
  });
  assert.deepEqual(calls, [['update'], ['audit', 'fix']]);
  assert.equal(result.auditLog, 'ok');
});

// ---------------------------------------------------------------------------

// The label table mixed tenses: `spec` printed "planning" (what is next) while `plan` printed
// "spec" (what finished two steps back), so a ticket ready to implement read as "still writing the spec".
test('every ticket label names what is done, in one tense', () => {
  const stateDir = tempDir('labels');
  const repoRoot = tempDir('labels-repo');
  // A real ticket through the real store — createTicket already records
  // STAGES.CREATE, so the callers below add only what comes after it.
  // Each probe needs its own idea, because the same name twice is refused.
  let probe = 0;
  const at = (...stages: Stage[]) => {
    const { id } = createTicket({ stateDir, repoRoot, content: `label probe ${++probe}` });
    for (const stage of stages) recordStage(stateDir, id, stage);
    return describeTicket(readTicket(stateDir, id));
  };

  assert.equal(at(), 'brainstorming');
  assert.equal(at(STAGES.SPEC), 'spec-written');
  assert.equal(at(STAGES.SPEC, STAGES.PLAN), 'planned');
  assert.equal(at(STAGES.GENESIS), 'planned');
  assert.equal(at(STAGES.GENESIS, STAGES.ERGON), 'coded');
  assert.equal(at(STAGES.GENESIS, STAGES.ERGON, STAGES.REVIEW), 'reviewed');
  assert.equal(at(STAGES.GENESIS, STAGES.REVIEW, STAGES.EPISTLE), 'pushed');

  // The old labels are the bug. None of them may come back.
  const seen = [
    at(STAGES.SPEC),
    at(STAGES.SPEC, STAGES.PLAN),
    at(STAGES.GENESIS, STAGES.ERGON),
    at(STAGES.GENESIS, STAGES.REVIEW, STAGES.EPISTLE),
  ];
  for (const label of seen) {
    assert.ok(!['planning', 'spec', 'code', 'push'].includes(label), `${label} regressed`);
  }
});

// ---------------------------------------------------------------------------

// JSON.parse names a character offset and nothing else. glafka reads at least
// four JSON files from a project; every other one already names itself.
test('a malformed .glafka.json error names the file', () => {
  const repoRoot = tempDir('config');
  fs.writeFileSync(path.join(repoRoot, '.glafka.json'), '{ "baseRef": "main", }');

  assert.throws(
    () => loadConfig(repoRoot),
    (err: Error) => err.message.includes('.glafka.json') && err.message.includes('not valid JSON'),
  );
});

// Ticket ids are eight random hex characters, so mistyping one is the everyday
// mistake. A bare ENOENT naming an internal path is not an answer to it.
test('an unknown ticket id says so, and says how to list the real ones', () => {
  const stateDir = tempDir('tickets');
  assert.throws(
    () => readTicket(stateDir, '2026-08-07-sweep-the-leftovers'),
    (err: Error) =>
      err.message.includes('no ticket "2026-08-07-sweep-the-leftovers"') &&
      err.message.includes('poreia --all') &&
      !err.message.startsWith('ENOENT'),
  );
});

// git's own "fatal: not a git repository" printed to the terminal AND was
// repeated inside the wrapped message, and never named glafka.
test('running outside a git repository says so in glafka terms', () => {
  const outside = tempDir('nogit');
  const previous = process.cwd();
  try {
    process.chdir(outside);
    assert.throws(
      () => findRepoRoot(),
      (err: Error) =>
        err.message.includes('glafka needs to run inside a git repository') &&
        !err.message.includes('rev-parse'),
    );
  } finally {
    process.chdir(previous);
  }
});

// ---------------------------------------------------------------------------

test('uncommittedPaths names the files that would be destroyed', () => {
  const repoRoot = makeGitRepo();
  assert.deepEqual(uncommittedPaths(repoRoot), []);

  fs.writeFileSync(path.join(repoRoot, 'important.js'), 'work\n');
  const dirty = uncommittedPaths(repoRoot);
  assert.equal(dirty.length, 1);
  assert.ok(dirty[0]!.includes('important.js'));
});

// A worktree that is already gone is the teardown's problem to report, not
// this check's — it must not throw on the way past.
test('uncommittedPaths reports nothing for a directory that is not there', () => {
  assert.deepEqual(uncommittedPaths(path.join(os.tmpdir(), 'glafka-does-not-exist-xyz')), []);
});

// ---------------------------------------------------------------------------

// A bare `--explain` interpolated the string "undefined" into the message and
// exited 0. The CLI checks the name against this list before calling in.
test('LAYER_NAMES lists every layer --explain accepts', () => {
  assert.ok(LAYER_NAMES.includes('filesystem'));
  assert.ok(LAYER_NAMES.includes('exec'));
  assert.ok(LAYER_NAMES.includes('sandbox'));
  assert.equal(LAYER_NAMES.includes('undefined'), false);
});

// ---------------------------------------------------------------------------

// `vima` read `.glafka.json`'s agents.coder and `ergon --background` read only
// the env var, so the same config gave two different answers.
test('the no-agent message names all three places the command can be set', () => {
  const message = noAgentCmd('--background');
  assert.ok(message.includes('.glafka.json'));
  assert.ok(message.includes('agents'));
  assert.ok(message.includes('coder'));
  assert.ok(message.includes('GLAFKA_AGENT_CMD'));
});

// ---------------------------------------------------------------------------

// The README said to drop a custom persona into `personas/`. In a project that is
// `.glafka/personas/`, which is git-ignored — never shared, gone on a fresh clone. A project's own live in git-tracked docs/glafka/personas/.
test('a project persona is found, and overrides a shipped one of the same name', () => {
  const repoRoot = tempDir('personas-repo');
  const shipped = tempDir('personas-shipped');
  fs.writeFileSync(path.join(shipped, 'teacher.md'), 'shipped teacher\n');
  fs.writeFileSync(path.join(shipped, 'greek.md'), 'shipped greek\n');

  const project = projectPersonasDir(repoRoot);
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'blunt.md'), 'project blunt\n');
  fs.writeFileSync(path.join(project, 'teacher.md'), 'project teacher\n');

  const dirs = [project, shipped];
  assert.deepEqual(listPersonas(dirs), ['blunt', 'greek', 'teacher']);
  assert.equal(loadPersonaContent(dirs, 'blunt'), 'project blunt\n');
  assert.equal(loadPersonaContent(dirs, 'teacher'), 'project teacher\n');
  assert.equal(loadPersonaContent(dirs, 'greek'), 'shipped greek\n');

  // A project persona is a real name, so toggling it must work.
  const stateDir = tempDir('personas-state');
  assert.deepEqual(setActivePersona(stateDir, dirs, 'blunt'), ['blunt']);
});

test('a missing personas directory is not an error', () => {
  const shipped = tempDir('personas-only');
  fs.writeFileSync(path.join(shipped, 'greek.md'), 'g\n');
  assert.deepEqual(listPersonas([path.join(os.tmpdir(), 'glafka-nope-xyz'), shipped]), ['greek']);
});

// ---------------------------------------------------------------------------

// `glafka --help` printed a bare list of twenty Greek verbs, to stderr, with exit 1 — and outside a
// git repo it printed a raw git error instead. The BUILT cli, not the TypeScript source: these run from a directory that is deliberately not a git repo, and `--import tsx` cannot resolve from there.
const BUILT_CLI = path.resolve(import.meta.dirname, '../../dist/installKit/bin/glafka.js');

test('--help describes every command, on stdout, with exit 0, outside a git repo', () => {
  const outside = tempDir('help-nogit');
  const out = execFileSync(process.execPath, [BUILT_CLI, '--help'], {
    cwd: outside,
    encoding: 'utf8',
  });

  for (const name of ['poreia', 'vima', 'logos', 'hygeia', 'prosopon', 'krisis', 'aporia']) {
    assert.ok(new RegExp(`^\\s+${name}\\s+\\S`, 'm').test(out), `${name} needs a description`);
  }
  assert.ok(out.includes('poreia --all'), 'must say how to list tickets');
});

test('a bare glafka exits 1 and still explains itself', () => {
  const outside = tempDir('help-bare');
  let status: number | null = null;
  let stderr = '';
  try {
    execFileSync(process.execPath, [BUILT_CLI], {
      cwd: outside,
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } catch (err) {
    const e = err as { status: number; stderr: string };
    status = e.status;
    stderr = e.stderr;
  }
  assert.equal(status, 1, 'no arguments is a usage error, not a success');
  assert.ok(stderr.includes('usage: glafka <command>'), `stderr was: ${stderr}`);
});

// ---------------------------------------------------------------------------
// The test above walks skills -> slash commands, so a COMMAND with no skill is invisible to it.
// `prosopon` had none on any platform: the only way to reach it from a session was to ask the agent
// to type the CLI. This walks the other way.

// COMMANDS is not exported, and importing glafka.ts would run the CLI. Read the source.
function commandNames(): string[] {
  const source = fs.readFileSync(
    path.resolve(import.meta.dirname, '../../installKit/bin/glafka.ts'),
    'utf8',
  );
  const block = /const COMMANDS[^=]*=\s*\[([\s\S]*?)\n\];/.exec(source);
  assert.ok(block, 'could not find the COMMANDS list in glafka.ts');
  return [...block[1]!.matchAll(/^\s*\['([^']+)'/gm)].map((m) => m[1]!);
}

// Named, not counted. Every one here is a decision that this command is reached by typing it,
// never from a session — and a new command is a failing test until someone says which it is.
const CLI_ONLY = new Set([
  'install', // run once, before any session exists
  'version',
  'create', // the three ticket-writing verbs a skill calls for you
  'spec',
  'plan',
  'poreia', // status, printed for a person
  'logos',
  'psyche', // the agent calls these from inside another skill's flow
  'apofasi',
  'krisis',
  'epalitheusis', // QA tester records one result for one AC
  'aporia',
  // Same shape: epistle's own refusal names it, and epistle.md walks through it. It verifies a
  // ticket rather than moving one, so it earns no lifecycle skill of its own.
  'checks',
  'guardrails',
  'hygeia',
  'audit',
]);

test('every command is reachable from a session, or is named as CLI-only on purpose', () => {
  const skills = new Set(
    fs
      .readdirSync(path.resolve(import.meta.dirname, '../../installKit/skills'))
      .filter((name) => name.endsWith('.md'))
      .map((name) => name.replace(/\.md$/, '')),
  );

  const unreachable = commandNames().filter((name) => !skills.has(name) && !CLI_ONLY.has(name));

  assert.deepEqual(
    unreachable,
    [],
    `no skill and not listed as CLI-only: ${unreachable.join(', ')}`,
  );
});

// A stale entry is its own bug: it says a command is deliberately unreachable when it has a skill.
test('nothing is listed as CLI-only while also shipping a skill', () => {
  const withSkills = fs
    .readdirSync(path.resolve(import.meta.dirname, '../../installKit/skills'))
    .filter((name) => name.endsWith('.md'))
    .map((name) => name.replace(/\.md$/, ''))
    .filter((name) => CLI_ONLY.has(name));

  assert.deepEqual(withSkills, []);
});
