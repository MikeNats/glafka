import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeGitRepo } from '../helpers/gitFixture.js';
import { makeTempDir } from '../helpers/tempDir.js';
import { createTicket, genesis } from '../../src/commands/genesis/genesis.js';
import { heureka } from '../../src/commands/heureka/heureka.js';
import { runSpec } from '../../installKit/bin/commands/spec.js';
import { readTicket, listTickets } from '../../src/ticket/ticketStore.js';

const CONFIG = { observability: { enabled: false } };

// Collects what a command prints, so a test can read it.
function capture(fn: () => void): { out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const { log, error } = console;
  console.log = (...a: unknown[]) => void out.push(a.join(' '));
  console.error = (...a: unknown[]) => void err.push(a.join(' '));
  try {
    fn();
  } finally {
    console.log = log;
    console.error = error;
  }
  return { out: out.join('\n'), err: err.join('\n') };
}

function specFile(body: string): string {
  const file = path.join(makeTempDir('spec'), 'spec.md');
  fs.writeFileSync(file, body);
  return file;
}

function setup() {
  const repoRoot = makeGitRepo();
  const stateDir = makeTempDir('state');
  const ticket = createTicket({ repoRoot, stateDir, content: 'task' });
  return { repoRoot, stateDir, id: ticket.id };
}

test('AC-1: a spec with no AC says epalitheusis will be skipped', () => {
  const { repoRoot, stateDir, id } = setup();
  const { out } = capture(() =>
    runSpec({
      args: [id, specFile('# T\n\n## Why\n\nx\n')],
      stateDir,
      repoRoot,
      config: CONFIG,
    }),
  );
  assert.match(out, /no acceptance criteria — epalitheusis will be skipped/);
});

test('AC-2: the same AC id twice is refused, and named', () => {
  const { repoRoot, stateDir, id } = setup();
  const file = specFile('## Acceptance criteria\n- AC-1: a → b → c\n- AC-1: d → e → f\n');
  assert.throws(
    () => runSpec({ args: [id, file], stateDir, repoRoot, config: CONFIG }),
    /AC-1 appears twice/,
  );
  assert.equal(readTicket(stateDir, id).specPath, null);
});

test('AC-3: a bad line warns, names the line, and the spec is still recorded', () => {
  const { repoRoot, stateDir, id } = setup();
  const file = specFile('## Acceptance criteria\n- check it works\n- AC-1: a → b → c\n');
  const { out, err } = capture(() =>
    runSpec({ args: [id, file], stateDir, repoRoot, config: CONFIG }),
  );
  assert.match(err, /not an AC line, ignored: - check it works/);
  assert.match(out, /1 acceptance criteria — epalitheusis will check them/);
  assert.notEqual(readTicket(stateDir, id).specPath, null);
});

// AC lines under a heading the parser does not know would turn the gate off without a word.
test('C8: AC lines with no AC heading warn that they are ignored', () => {
  const { repoRoot, stateDir, id } = setup();
  const file = specFile('# T\n\n## Checks\n\n- AC-1: a → b → c\n');
  const { out, err } = capture(() =>
    runSpec({ args: [id, file], stateDir, repoRoot, config: CONFIG }),
  );
  assert.match(out, /no acceptance criteria — epalitheusis will be skipped/);
  assert.match(
    err,
    /warning: 1 "- AC-<n>:" line\(s\) sit under no "## Acceptance criteria" heading/,
  );
  assert.match(err, /- AC-1: a → b → c/);
});

test('C8: a common heading variant is read, and gives no warning', () => {
  const { repoRoot, stateDir, id } = setup();
  const file = specFile('# T\n\n## 4. Acceptance Criteria (AC):\n\n- AC-1: a → b → c\n');
  const { out, err } = capture(() =>
    runSpec({ args: [id, file], stateDir, repoRoot, config: CONFIG }),
  );
  assert.match(out, /1 acceptance criteria — epalitheusis will check them/);
  assert.equal(err, '');
});

// I6: an AC line after a sub-heading, or in a second section, is not read. Say so, by name.
test('AC lines outside the AC section warn, by name, even when the section exists', () => {
  const { repoRoot, stateDir, id } = setup();
  const spec = '### Acceptance criteria\n- AC-1: a → b → c\n### Error cases\n- AC-2: x → y → z\n';
  const { out, err } = capture(() =>
    runSpec({ args: [id, specFile(spec)], stateDir, repoRoot, config: CONFIG }),
  );
  assert.match(out, /1 acceptance criteria — epalitheusis will check them/);
  assert.match(err, /warning: 1 "- AC-<n>:" line\(s\) sit outside the acceptance criteria section/);
  assert.match(err, /- AC-2: x → y → z/);
});

// M8: every way a spec is stored refuses one AC id twice, not only spec.
const DUP_SPEC = '# T\n\n## Acceptance criteria\n- AC-1: a → b → c\n- AC-1: d → e → f\n';

test('createTicket refuses the same AC id twice, and stores nothing', () => {
  const repoRoot = makeGitRepo();
  const stateDir = makeTempDir('state');
  assert.throws(
    () => createTicket({ repoRoot, stateDir, content: DUP_SPEC }),
    /AC-1 appears twice/,
  );
  assert.deepEqual(listTickets(stateDir), []);
});

test('genesis() and heureka refuse the same AC id twice, before any worktree', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = makeTempDir('state');
  await assert.rejects(genesis({ repoRoot, stateDir, content: DUP_SPEC }), /AC-1 appears twice/);
  await assert.rejects(heureka({ repoRoot, stateDir, idea: DUP_SPEC }), /AC-1 appears twice/);
  assert.deepEqual(listTickets(stateDir), []);
  assert.equal(fs.existsSync(path.join(repoRoot, '.worktrees')), false);
});
