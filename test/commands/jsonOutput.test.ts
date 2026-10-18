import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { makeGitRepo } from '../helpers/gitFixture.js';
import { withoutAgentCmd } from '../helpers/noAgentEnv.js';
import { createTicket, genesis } from '../../src/commands/genesis/genesis.js';
import { lysis } from '../../src/commands/lysis/lysis.js';
import { cancel } from '../../src/commands/cancel/cancel.js';
import {
  openVerifyRound,
  appendVerifyResult,
  addCriterionSkip,
  recordStage,
  STAGES,
} from '../../src/ticket/ticketStore.js';
import { ticketFiles, ticketsDir } from '../../src/ticket/paths.js';
import { runPoreia } from '../../installKit/bin/commands/poreia.js';
import { runVima } from '../../installKit/bin/commands/vima.js';
import { runCreate } from '../../installKit/bin/commands/create.js';
import type { PoreiaJson } from '../../src/commands/poreia/json.js';
import type { VimaResult } from '../../src/commands/vima/utils.js';

// Elaia, the VS Code extension, reads these documents. No agent may start here.
withoutAgentCmd();

// Runs the built output, not the TS source. Run `npm run build` first.
const BIN = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'dist',
  'installKit',
  'bin',
  'glafka.js',
);

const SPEC = [
  '# Dark mode',
  '',
  '## Acceptance criteria',
  '',
  '- AC-1: light page → press the toggle → the page turns dark',
  '- AC-2: dark page → reload → it stays dark',
  '',
].join('\n');

function stateDirFor(repoRoot: string) {
  return path.join(repoRoot, '.glafka');
}

// A plain config. Does not read any real .glafka.json file.
function baseConfig() {
  return {
    baseRef: 'main',
    checksCmd: null,
    e2eCmd: null,
    checksTimeoutMs: 10_000,
    e2eTimeoutMs: 10_000,
    ergonTimeoutMs: 60_000,
    agents: {},
    maxReviewRounds: 3,
    notifyCmd: null,
    reviewDoc: null,
    observability: { enabled: false },
  };
}

// What a command printed on stdout, in this process.
async function stdoutOf(fn: () => unknown): Promise<string> {
  const out: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...args: unknown[]) => out.push(args.map(String).join(' '));
  console.error = () => {};
  try {
    await fn();
  } finally {
    console.log = realLog;
    console.error = realError;
  }
  return out.join('\n');
}

function runCli(repoRoot: string, args: string[]) {
  const result = spawnSync('node', [BIN, ...args], { cwd: repoRoot, encoding: 'utf8' });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', code: result.status ?? 1 };
}

// --------------------------------------------------------------------------- The contract.
// A change to these keys breaks Elaia. Change the list only together with Elaia.

const POREIA_JSON_KEYS = [
  // Every PoreiaView field.
  'id',
  'title',
  'position',
  'closed',
  'cancelled',
  'specWritten',
  'planned',
  'exploring',
  'coder',
  'progress',
  'steps',
  'aporia',
  'reviewRequested',
  'reviewedAt',
  'unreviewedCommit',
  'checksOutcome',
  'devRunning',
  'review',
  'pushed',
  'branchPushed',
  'prUrl',
  // Added for Elaia.
  'worktree',
  'branch',
  'specPath',
  'planPath',
  'created',
  'updated',
  'stages',
  'criteria',
  'criteriaSkips',
  'qa',
  'qaGap',
  'summary',
];

test('poreia --json keeps the exact contract Elaia reads', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = stateDirFor(repoRoot);
  const ticket = createTicket({ stateDir, repoRoot, content: SPEC });

  const out = await stdoutOf(() =>
    runPoreia({ args: [ticket.id, '--json'], stateDir, repoRoot, config: { baseRef: 'main' } }),
  );
  const doc = JSON.parse(out) as { contract: number; tickets: PoreiaJson[] };

  assert.deepEqual(Object.keys(doc).sort(), ['contract', 'tickets']);
  assert.equal(doc.contract, 1);
  assert.equal(doc.tickets.length, 1);
  assert.deepEqual(Object.keys(doc.tickets[0]!).sort(), [...POREIA_JSON_KEYS].sort());
});

test('poreia --json carries the ticket facts, the criteria and the summary', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = stateDirFor(repoRoot);
  const ticket = createTicket({ stateDir, repoRoot, content: SPEC });

  const out = await stdoutOf(() =>
    runPoreia({ args: [ticket.id, '--json'], stateDir, repoRoot, config: { baseRef: 'main' } }),
  );
  const [one] = (JSON.parse(out) as { tickets: PoreiaJson[] }).tickets;

  assert.equal(one!.id, ticket.id);
  assert.equal(one!.worktree, null);
  assert.equal(one!.branch, null);
  assert.equal(one!.specPath, null);
  assert.equal(one!.planPath, null);
  assert.equal(one!.created, ticket.created);
  assert.equal(typeof one!.updated, 'string');
  assert.deepEqual(one!.criteria, [
    { id: 'AC-1', text: 'light page → press the toggle → the page turns dark' },
    { id: 'AC-2', text: 'dark page → reload → it stays dark' },
  ]);
  assert.deepEqual(one!.criteriaSkips, []);
  assert.equal(one!.qa, null);
  assert.match(one!.qaGap!, /AC-1, AC-2 never verified/);
  assert.equal(one!.summary.rank, 2);
  assert.match(one!.summary.text, new RegExp(ticket.id));
  assert.deepEqual(
    one!.stages.map((s) => s.stage),
    ['create'],
  );
});

test('poreia --json gives [] criteria when the spec has none', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = stateDirFor(repoRoot);
  const ticket = createTicket({ stateDir, repoRoot, content: 'an idea with no criteria' });

  const out = await stdoutOf(() =>
    runPoreia({ args: [ticket.id, '--json'], stateDir, repoRoot, config: { baseRef: 'main' } }),
  );

  assert.deepEqual((JSON.parse(out) as { tickets: PoreiaJson[] }).tickets[0]!.criteria, []);
});

// The QA round and the skips are what Elaia draws next to each criterion.
test('poreia --json copies the QA round and the skipped criteria', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = stateDirFor(repoRoot);
  const ticket = createTicket({ stateDir, repoRoot, content: SPEC });
  openVerifyRound(stateDir, ticket.id, { token: 'tok', tree: 'abc', dirty: [], spawned: false });
  appendVerifyResult(stateDir, ticket.id, {
    ac: 'AC-1',
    result: 'pass',
    evidence: 'curl /x → 200',
  });
  addCriterionSkip(stateDir, ticket.id, { ac: 'AC-2', reason: 'needs a real phone' });

  const out = await stdoutOf(() =>
    runPoreia({ args: [ticket.id, '--json'], stateDir, repoRoot, config: { baseRef: 'main' } }),
  );
  const [one] = (JSON.parse(out) as { tickets: PoreiaJson[] }).tickets;

  assert.deepEqual(Object.keys(one!.qa!).sort(), ['openedAt', 'outcome', 'results']);
  assert.equal(one!.qa!.outcome, null);
  assert.equal(typeof one!.qa!.openedAt, 'string');
  assert.equal(one!.qa!.results.length, 1);
  assert.deepEqual(Object.keys(one!.qa!.results[0]!).sort(), [
    'at',
    'evidence',
    'id',
    'result',
    'verified',
  ]);
  assert.equal(one!.qa!.results[0]!.result, 'pass');
  assert.equal(one!.criteriaSkips.length, 1);
  assert.deepEqual(Object.keys(one!.criteriaSkips[0]!).sort(), ['at', 'id', 'reason']);
  assert.equal(one!.criteriaSkips[0]!.reason, 'needs a real phone');
});

// The review status read from disk carries the whole ticket, token hashes too.
// Elaia gets the review summary only.
test('poreia --json review holds the summary fields, not the raw ticket', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = stateDirFor(repoRoot);
  const ticket = createTicket({ stateDir, repoRoot, content: SPEC });
  openVerifyRound(stateDir, ticket.id, { token: 'tok', tree: 'abc', dirty: [], spawned: false });

  const out = await stdoutOf(() =>
    runPoreia({ args: [ticket.id, '--json'], stateDir, repoRoot, config: { baseRef: 'main' } }),
  );
  const [one] = (JSON.parse(out) as { tickets: PoreiaJson[] }).tickets;

  assert.deepEqual(Object.keys(one!.review).sort(), [
    'back',
    'findings',
    'status',
    'total',
    'verdict',
  ]);
  assert.doesNotMatch(out, /"token"|reviewToken|specText/);
});

// qaBlocked is an inside mark on the stage log. Elaia gets at, stage and note only.
test('poreia --json lists every stage in order, with no inside marks', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = stateDirFor(repoRoot);
  const ticket = createTicket({ stateDir, repoRoot, content: SPEC });
  recordStage(stateDir, ticket.id, STAGES.REVIEW, 'checks-unknown', { qaBlocked: true });

  const out = await stdoutOf(() =>
    runPoreia({ args: [ticket.id, '--json'], stateDir, repoRoot, config: { baseRef: 'main' } }),
  );
  const [one] = (JSON.parse(out) as { tickets: PoreiaJson[] }).tickets;

  assert.deepEqual(
    one!.stages.map((s) => [s.stage, s.note]),
    [
      ['create', null],
      ['review', 'checks-unknown'],
    ],
  );
  for (const stage of one!.stages)
    assert.deepEqual(Object.keys(stage).sort(), ['at', 'note', 'stage']);
});

test('poreia --all --json lists every open ticket in the same wrapper', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = stateDirFor(repoRoot);
  const first = createTicket({ stateDir, repoRoot, content: 'first task' });
  const second = createTicket({ stateDir, repoRoot, content: 'second task' });

  const out = await stdoutOf(() =>
    runPoreia({ args: ['--all', '--json'], stateDir, repoRoot, config: { baseRef: 'main' } }),
  );
  const doc = JSON.parse(out) as { contract: number; tickets: PoreiaJson[] };

  assert.equal(doc.contract, 1);
  assert.deepEqual(doc.tickets.map((t) => t.id).sort(), [first.id, second.id].sort());
  for (const one of doc.tickets) {
    assert.deepEqual(Object.keys(one).sort(), [...POREIA_JSON_KEYS].sort());
  }
});

test('poreia --all --json with no tickets is an empty list, not text', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = stateDirFor(repoRoot);

  const out = await stdoutOf(() =>
    runPoreia({ args: ['--all', '--json'], stateDir, repoRoot, config: { baseRef: 'main' } }),
  );

  assert.deepEqual(JSON.parse(out), { contract: 1, tickets: [] });
});

// A closed ticket lives under tickets/closed/. Elaia still opens it by id.
test('poreia <id> --json works for a closed ticket', { concurrency: true }, async () => {
  const repoRoot = makeGitRepo();
  const stateDir = stateDirFor(repoRoot);
  const ticket = await genesis({ repoRoot, stateDir, content: SPEC });
  await lysis({ repoRoot, stateDir, id: ticket.id, keep: 'all' });

  const out = await stdoutOf(() =>
    runPoreia({ args: [ticket.id, '--json'], stateDir, repoRoot, config: { baseRef: 'main' } }),
  );
  const [one] = (JSON.parse(out) as { tickets: PoreiaJson[] }).tickets;

  assert.equal(one!.closed, true);
  assert.equal(one!.stages.at(-1)!.stage, 'lysis');
  assert.equal(one!.criteria.length, 2);
  assert.deepEqual(one!.summary, { rank: 3, text: `${ticket.id}  closed` });
});

test('poreia --json through the real command prints only the JSON on stdout', () => {
  const repoRoot = makeGitRepo();
  const stateDir = stateDirFor(repoRoot);
  const ticket = createTicket({ stateDir, repoRoot, content: SPEC });

  const { stdout, code } = runCli(repoRoot, ['poreia', ticket.id, '--json']);

  assert.equal(code, 0);
  assert.equal((JSON.parse(stdout) as { tickets: PoreiaJson[] }).tickets[0]!.id, ticket.id);
});

// --------------------------------------------------------------------------- vima

test('vima <id> --json prints the one result in the contract wrapper', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = stateDirFor(repoRoot);
  const ticket = createTicket({ stateDir, repoRoot, content: 'task' });
  await cancel({ repoRoot, stateDir, id: ticket.id });

  const out = await stdoutOf(() =>
    runVima({ args: [ticket.id, '--json'], stateDir, repoRoot, config: baseConfig() }),
  );

  assert.deepEqual(JSON.parse(out), {
    contract: 1,
    results: [{ id: ticket.id, action: 'none', reason: 'cancelled' }],
  });
});

test('vima --all --json prints every result in one document', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = stateDirFor(repoRoot);
  const first = createTicket({ stateDir, repoRoot, content: 'first task' });
  const second = createTicket({ stateDir, repoRoot, content: 'second task' });

  const out = await stdoutOf(() =>
    runVima({ args: ['--all', '--json'], stateDir, repoRoot, config: baseConfig() }),
  );
  const doc = JSON.parse(out) as { contract: number; results: VimaResult[] };

  assert.equal(doc.contract, 1);
  assert.deepEqual(doc.results.map((r) => r.id).sort(), [first.id, second.id].sort());
});

test('vima --json with --restart is refused, not half done', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = stateDirFor(repoRoot);

  await assert.rejects(
    () =>
      runVima({ args: ['--all', '--restart', '--json'], stateDir, repoRoot, config: baseConfig() }),
    /--json is not supported with --restart/,
  );
});

// The exit code is how a timer notices. JSON mode must not lose it.
test('vima --all --json still exits 1 when a ticket errored', () => {
  const repoRoot = makeGitRepo();
  const stateDir = stateDirFor(repoRoot);
  const broken = createTicket({ stateDir, repoRoot, content: 'broken task' });
  fs.writeFileSync(ticketFiles(ticketsDir(stateDir), broken.id).ticketFile, '{ not json');

  const { stdout, stderr, code } = runCli(repoRoot, ['vima', '--all', '--json']);

  assert.equal(code, 1);
  const doc = JSON.parse(stdout) as { contract: number; results: VimaResult[] };
  assert.equal(doc.contract, 1);
  assert.equal(doc.results[0]!.action, 'error');
  assert.match(stderr, /errored this tick/);
});

// --------------------------------------------------------------------------- create

test('create --json prints the id and position, and keeps --json out of the idea', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = stateDirFor(repoRoot);

  const out = await stdoutOf(() =>
    runCreate({
      args: ['add', 'dark', 'mode', '--json'],
      stateDir,
      repoRoot,
      config: { baseRef: 'main' },
    }),
  );
  const doc = JSON.parse(out) as { contract: number; id: string; position: string };

  assert.deepEqual(Object.keys(doc).sort(), ['contract', 'id', 'position']);
  assert.equal(doc.contract, 1);
  assert.match(doc.id, /-add-dark-mode$/);
  assert.equal(typeof doc.position, 'string');
  const { tickets } = JSON.parse(
    await stdoutOf(() =>
      runPoreia({ args: [doc.id, '--json'], stateDir, repoRoot, config: { baseRef: 'main' } }),
    ),
  ) as { tickets: PoreiaJson[] };
  assert.equal(tickets[0]!.position, doc.position);
});

test('create --json works with --name', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = stateDirFor(repoRoot);

  const out = await stdoutOf(() =>
    runCreate({
      args: ['--json', '修正', '--name', 'fix the title'],
      stateDir,
      repoRoot,
      config: { baseRef: 'main' },
    }),
  );

  assert.match((JSON.parse(out) as { id: string }).id, /-fix-the-title$/);
});

// The guardrails note is advice, not data. It must stay off stdout.
test('create --json through the real command prints only the JSON on stdout', () => {
  const repoRoot = makeGitRepo();

  const { stdout, stderr, code } = runCli(repoRoot, ['create', 'add a thing', '--json']);

  assert.equal(code, 0);
  const doc = JSON.parse(stdout) as { contract: number; id: string };
  assert.equal(doc.contract, 1);
  assert.match(doc.id, /-add-a-thing$/);
  assert.match(stderr, /guardrails are off/);
});
