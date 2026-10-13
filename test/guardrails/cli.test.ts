import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeGitRepo } from '../helpers/gitFixture.js';
import { genesis } from '../../src/commands/genesis/genesis.js';
import { readTicket, writeTicket } from '../../src/ticket/ticketStore.js';
import { ticketLockPath } from '../../src/ticket/paths.js';
import { ethosPath, readDoc } from '../../src/memory/docsStore.js';
import { DEFAULT_CATEGORIES, targetOf } from '../../src/memory/categories.js';

const T = Object.fromEntries(DEFAULT_CATEGORIES.map((c) => [c.name, targetOf(c)]));

// These tests run the real built CLI, not the source code.
// Run `npm run build` first.
const BIN = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'dist',
  'installKit',
  'bin',
  'glafka.js',
);

function stateDirFor(repoRoot: string) {
  return path.join(repoRoot, '.glafka');
}

function runGuardrails(repoRoot: string, args: string[]) {
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

// Old bug: the number after --level was read as the ticket id.
// The --level flag itself was ignored.
test(
  'guardrails --test --level 4 resolves the real ticket id and actually honors the level override',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = stateDirFor(repoRoot);
    const ticket = await genesis({ repoRoot, stateDir, content: 'task', planContent: '1. do it' });

    const { out, code } = runGuardrails(repoRoot, ['--test', '--level', '4']);

    assert.match(out, new RegExp(`^${ticket.id}:`, 'm'));
    // The --level flag must still be used.
    assert.doesNotMatch(out, /level 0 has no sandbox/);
    assert.equal(code, 0);
  },
);

// Old bug: with no id given, it picked the oldest ticket.
// It should pick the newest one.
test(
  'guardrails --test with no id falls back to the newest ticket, not the oldest',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = stateDirFor(repoRoot);
    await genesis({ repoRoot, stateDir, content: 'older ticket' });
    const newer = await genesis({ repoRoot, stateDir, content: 'newer ticket' });

    const { out } = runGuardrails(repoRoot, ['--test']);

    assert.match(out, new RegExp(`^${newer.id}:`, 'm'));
  },
);

// Old bug: --log with no id showed "0 decisions" instead
// of a real error.
test('guardrails --log with no id errors instead of silently reporting 0 decisions for no ticket', () => {
  const repoRoot = makeGitRepo();

  const { out, code } = runGuardrails(repoRoot, ['--log']);

  assert.match(out, /--log needs a ticket id/);
  assert.equal(code, 1);
});

test('guardrails --log with a nonexistent ticket id fails loudly instead of reading an empty log silently', () => {
  const repoRoot = makeGitRepo();

  const { code } = runGuardrails(repoRoot, ['--log', '2026-08-07-sweep-the-leftovers']);

  assert.equal(code, 1);
});

test(
  "guardrails --log <real id> names the ticket in its own report, and --level's value is never mistaken for one",
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = stateDirFor(repoRoot);
    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });

    const { out, code } = runGuardrails(repoRoot, ['--log', ticket.id]);

    assert.match(out, new RegExp(`^${ticket.id}: \\d+ decision\\(s\\) logged`));
    assert.equal(code, 0);
  },
);

// Old bug: loosened settings were missing from the report.
test(
  "ergon --background reports a project's widened guardrails settings at spawn time",
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = stateDirFor(repoRoot);
    fs.mkdirSync(path.join(repoRoot, 'docs', 'glafka'), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, 'docs', 'glafka', 'guardrails.json'),
      JSON.stringify({ level: 2, exec: { allow: [{ cmd: 'sh', anyArgs: true }] } }),
    );
    const ticket = await genesis({ repoRoot, stateDir, content: 'task', planContent: '1. do it' });

    const out = execFileSync('node', [BIN, 'ergon', ticket.id, '--background'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, GLAFKA_AGENT_CMD: 'true' },
    });

    assert.match(out, /this project loosened: exec\.allow/);
  },
);

// Same bug as before: --level's number was read as the ticket id.
test(
  "guardrails --explain <layer> --level <n> does not mistake the level's value for the ticket id",
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = stateDirFor(repoRoot);
    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });

    const { out, code } = runGuardrails(repoRoot, [
      '--explain',
      'filesystem',
      '--level',
      '4',
      ticket.id,
    ]);

    assert.equal(code, 0);
    assert.match(out, /filesystem/);
  },
);

// Same bug: a flag written before the id was read as the id.
function run(bin: string, args: string[], opts: { cwd?: string } = {}) {
  try {
    const out = execFileSync('node', [bin, ...args], {
      encoding: 'utf8',
      ...opts,
    });
    return { out, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { out: `${e.stdout ?? ''}${e.stderr ?? ''}`, code: e.status ?? 1 };
  }
}

test(
  'aporia --reason before the id still resolves the real ticket, not the reason text',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = stateDirFor(repoRoot);
    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });

    const { out, code } = run(BIN, ['aporia', '--reason', 'the plan is wrong', ticket.id], {
      cwd: repoRoot,
    });

    assert.equal(code, 0);
    assert.match(out, new RegExp(`^${ticket.id}  aporia recorded: the plan is wrong`, 'm'));
    assert.equal(readTicket(stateDir, ticket.id).aporia!.reason, 'the plan is wrong');
  },
);

test(
  "krisis --verdict/--finding before the id still resolves the real ticket, not a flag's own value",
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = stateDirFor(repoRoot);
    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });

    const { out, code } = run(
      BIN,
      ['krisis', '--verdict', 'blocking', '--finding', 'src/a.js:1 — SQL injection', ticket.id],
      { cwd: repoRoot },
    );

    assert.equal(code, 0);
    assert.match(out, new RegExp(`^${ticket.id}  \\[blocking\\] src/a.js:1 — SQL injection`, 'm'));
    const findings = readTicket(stateDir, ticket.id).reviewFindings;
    assert.equal(findings.length, 1);
    assert.equal(findings[0].verdict, 'blocking');
    // The id should not end up inside the finding text.
    assert.equal(findings[0].finding, 'src/a.js:1 — SQL injection');
  },
);

test(
  'lysis --keep before the id still resolves the real ticket, and the keep selection still applies',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = stateDirFor(repoRoot);
    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });
    writeTicket(stateDir, {
      ...ticket,
      ethosCandidates: [
        { status: 'pending', source: 'agent', target: T.CODE, text: 'prefer small functions' },
        { status: 'pending', source: 'you', target: T.SECURITY, text: 'never log request bodies' },
      ],
    });

    const { out, code } = run(BIN, ['lysis', '--keep', 'all', ticket.id], { cwd: repoRoot });

    assert.equal(code, 0);
    assert.match(out, new RegExp(`^${ticket.id} ->`, 'm'));
    assert.match(readDoc(ethosPath(repoRoot, T.CODE)), /prefer small functions/);
    assert.match(readDoc(ethosPath(repoRoot, T.SECURITY)), /never log request bodies/);
  },
);

// Old bug: a crash before startup returned exit code 1.
// Code 1 means "allow", so unsafe actions could slip through.
test('a hook dispatcher that cannot load exits 2, not 1', () => {
  const payload = JSON.stringify({
    tool_name: 'Read',
    tool_input: { file_path: 'README.md' },
    cwd: process.cwd(),
  });

  const result = spawnSync('node', [BIN, 'guardrails', '--run-hook', 'nosuchadapter'], {
    input: payload,
    encoding: 'utf8',
  });

  assert.equal(result.status, 2, 'anything other than 2 is read as "allow" by the harness');
  const decision = JSON.parse(result.stdout.split('\n')[0]);
  assert.equal(decision.decision, 'block');
});

// The widest race window of these: --repin read the ticket,
// then wrote it back with no <id>.json.lock at all, so it could clobber a concurrent krisis/aporia write from a running agent. It now goes through the same lock updateTicket uses.
test(
  'guardrails --repin refuses while another writer holds the ticket lock',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = stateDirFor(repoRoot);
    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });

    const lockPath = ticketLockPath(stateDir, ticket.id);
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), {
      flag: 'wx',
    });

    const { out, code } = run(BIN, ['guardrails', '--repin', ticket.id], { cwd: repoRoot });
    assert.notEqual(code, 0);
    assert.match(out, /still locked/);
    fs.unlinkSync(lockPath);

    // Retrying after the lock clears must succeed cleanly.
    const retried = run(BIN, ['guardrails', '--repin', ticket.id], { cwd: repoRoot });
    assert.equal(retried.code, 0);
    assert.match(retried.out, /repinned/);
  },
);
