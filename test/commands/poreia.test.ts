import { test } from 'node:test';
import { ergonStatus } from '../../src/commands/ergon/ergon.js';
import { makeTempDir } from '../helpers/tempDir.js';
import {
  writeTicket,
  recordStage,
  readTicket,
  isReviewedSinceLastChange,
  appendReviewFinding,
  STAGES,
  RUN_OUTCOMES,
} from '../../src/ticket/ticketStore.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { makeGitRepo } from '../helpers/gitFixture.js';
import { genesis, createTicket } from '../../src/commands/genesis/genesis.js';
import { heureka } from '../../src/commands/heureka/heureka.js';
import { ergonBackground, ergonReview, dispatchReviewer } from '../../src/commands/ergon/ergon.js';
import { lysis } from '../../src/commands/lysis/lysis.js';
import { cancel } from '../../src/commands/cancel/cancel.js';
import { recordAporia } from '../../src/ticket/ticketStore.js';
import {
  poreia,
  poreiaAll,
  renderPoreia,
  renderPoreiaAll,
  SYMBOL,
} from '../../src/commands/poreia/poreia.js';
import { checksLine } from '../../src/commands/poreia/utils.js';

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

function stateDirFor(repoRoot: string) {
  return path.join(repoRoot, '.glafka');
}

// 60s, not 20s. These wait on a real spawned process, and a full `npm test` saturates the machine, so
// a cold process can take well past 20s to be scheduled. The assertions are about ordering, not speed.
function waitFor(
  predicate: () => boolean,
  { timeoutMs = 60000, intervalMs = 20 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('timed out waiting'));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

function commit(worktree: string, name: string, content: string) {
  fs.writeFileSync(path.join(worktree, name), content);
  execFileSync('git', ['add', name], { cwd: worktree });
  execFileSync('git', ['commit', '-q', '-m', name], { cwd: worktree });
}

// --------------------------------------------------------------------------- This just reads fields.
// No LLM. No new storage. ---------------------------------------------------------------------------

test('a fresh phased ticket (create only) shows no spec, no plan, nothing else started', () => {
  const repoRoot = makeGitRepo();
  const stateDir = stateDirFor(repoRoot);
  const ticket = createTicket({ stateDir, repoRoot, content: 'an idea' });

  const view = poreia({ stateDir, id: ticket.id });

  assert.equal(view.specWritten, false);
  assert.equal(view.planned, false);
  assert.equal(view.exploring, false);
  assert.equal(view.progress, null, 'no plan-approval baseline yet');
  assert.deepEqual(view.steps, []);
  assert.equal(view.reviewRequested, false);
  assert.equal(view.pushed, false);
  assert.equal(view.closed, false);
});

test(
  'a heureka ticket reads as exploring, not as a plan stalled before approval',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = stateDirFor(repoRoot);
    const { ticket } = await heureka({ repoRoot, stateDir, idea: 'try something' });

    const view = poreia({ stateDir, id: ticket.id });

    assert.equal(view.exploring, true);
    assert.equal(view.planned, false);
    // No baseline for heureka, so progress is null. This is expected, not a guess.
    assert.equal(view.progress, null);
  },
);

test(
  "committed steps show up as the ordered list ergon's own 'commit after each step' rule produces",
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = stateDirFor(repoRoot);
    const ticket = await genesis({ repoRoot, stateDir, content: 'task', planContent: '1. do it' });
    commit(ticket.worktree!, 'step1.txt', 'one');
    commit(ticket.worktree!, 'step2.txt', 'two');

    const view = poreia({ stateDir, id: ticket.id });

    assert.deepEqual(view.steps, ['step1.txt', 'step2.txt']);
    assert.equal(view.progress!.commits, 2);
  },
);

test(
  'a live coder run is reflected in the coder background status',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = stateDirFor(repoRoot);
    const ticket = await genesis({ repoRoot, stateDir, content: 'task', planContent: '1. do it' });
    const { pid } = await ergonBackground({
      stateDir,
      id: ticket.id,
      repoRoot,
      agentCmd: 'sleep 30',
    });

    const view = poreia({ stateDir, id: ticket.id });
    assert.equal(view.coder.state, 'running');

    process.kill(pid!, 'SIGKILL');
  },
);

// No package.json means checks are unknown, not passed.
// Review can still happen. Only a real failed verdict blocks it.
test(
  'a checks-unknown ticket can still be reviewed, and the verdict surfaces honestly',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = stateDirFor(repoRoot);
    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });
    commit(ticket.worktree!, 'a.txt', 'a');

    const { ticket: prepared, prompt } = await ergonReview({
      stateDir,
      id: ticket.id,
      repoRoot,
      baseRef: 'main',
    });
    dispatchReviewer({
      stateDir,
      ticket: prepared,
      prompt,
      agentCmd: `node "${BIN}" krisis ${ticket.id} --verdict blocking --finding "needs a fix"`,
    });
    await waitFor(() => poreia({ stateDir, id: ticket.id }).review.status.state === 'finished');

    const view = poreia({ stateDir, id: ticket.id });
    assert.equal(view.checksOutcome, 'checks-unknown');
    assert.equal(view.review.verdict.verdict, 'blocking');
    assert.equal(view.reviewRequested, true);
  },
);

// A review that fails its checks still throws an error, but it saves
// the result first. poreia must show that result, not show nothing.
test(
  'a review that failed its own checks still shows checks-failed, even though it never completed',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    // package.json lives on main BEFORE the ticket branches off it, so it is not part of THIS ticket's
    // own diff — otherwise the (correct) refusal to auto-run an untrusted package.json turns this into an "unknown" check instead of a failed one.
    fs.writeFileSync(
      path.join(repoRoot, 'package.json'),
      JSON.stringify({ name: 'x', scripts: { test: 'exit 1' } }),
    );
    execFileSync('git', ['add', 'package.json'], { cwd: repoRoot });
    execFileSync('git', ['commit', '-q', '-m', 'add package.json'], { cwd: repoRoot });
    const stateDir = stateDirFor(repoRoot);
    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });

    await assert.rejects(() => ergonReview({ stateDir, id: ticket.id, repoRoot, baseRef: 'main' }));

    const view = poreia({ stateDir, id: ticket.id });
    assert.equal(view.checksOutcome, 'checks-failed');
  },
);

test('a cancelled ticket reads as cancelled', { concurrency: true }, async () => {
  const repoRoot = makeGitRepo();
  const stateDir = stateDirFor(repoRoot);
  const ticket = createTicket({ stateDir, repoRoot, content: 'task' });
  await cancel({ repoRoot, stateDir, id: ticket.id });

  assert.equal(poreia({ stateDir, id: ticket.id }).cancelled, true);
});

test('a closed ticket reads as closed', { concurrency: true }, async () => {
  const repoRoot = makeGitRepo();
  const stateDir = stateDirFor(repoRoot);
  const ticket = await genesis({ repoRoot, stateDir, content: 'task' });
  await lysis({ repoRoot, stateDir, id: ticket.id, keep: 'all' });

  assert.equal(poreia({ stateDir, id: ticket.id }).closed, true);
});

// --------------------------------------------------------------------------- This checks the facts
// shown, not the exact text. ---------------------------------------------------------------------------

test('renderPoreia shows spec/plan as pending for a brand new phased ticket', () => {
  const view = {
    id: '2026-08-07-add-dark-mode',
    title: 'x',
    closed: false,
    cancelled: false,
    specWritten: false,
    planned: false,
    exploring: false,
    coder: { state: 'not-started' },
    progress: null,
    steps: [],
    reviewRequested: false,
    checksOutcome: null,
    review: {
      status: { state: 'not-started' },
      findings: [],
      verdict: { source: 'not-done', verdict: null },
    },
    pushed: false,
    prUrl: null,
  };

  const out = renderPoreia(view);
  assert.match(out, new RegExp(`\\${SYMBOL.PENDING} spec written`));
  assert.match(out, new RegExp(`\\${SYMBOL.PENDING} plan approved`));
  assert.doesNotMatch(out, /checks/);
});

test('renderPoreia stops at cancelled/closed — nothing past that point is worth reading', () => {
  const cancelled = renderPoreia({ id: '2026-08-07-add-dark-mode', title: 'x', cancelled: true });
  assert.match(cancelled, /cancelled/);
  assert.doesNotMatch(cancelled, /spec written/);

  const closed = renderPoreia({
    id: '2026-08-07-add-dark-mode',
    title: 'x',
    cancelled: false,
    closed: true,
    pushed: true,
    prUrl: 'https://x/1',
  });
  assert.match(closed, /closed/);
  assert.match(closed, /pushed\s+https:\/\/x\/1/);
});

test('renderPoreia never prints a blocking verdict as clean, and shows the reason', () => {
  const view = {
    id: '2026-08-07-add-dark-mode',
    title: 'x',
    closed: false,
    cancelled: false,
    specWritten: true,
    planned: true,
    exploring: false,
    coder: { state: 'finished' },
    progress: { commits: 1, uncommittedChanges: false },
    steps: ['do it'],
    reviewRequested: true,
    checksOutcome: 'ok',
    review: {
      status: { state: 'finished' },
      findings: [{ verdict: 'blocking', finding: 'signup.js:44 no rate limit' }],
      verdict: { source: 'krisis', verdict: 'blocking' },
    },
    pushed: false,
    prUrl: null,
  };

  const out = renderPoreia(view);
  assert.match(out, new RegExp(`\\${SYMBOL.NEEDS_YOU} verdict: blocking`));
  assert.match(out, /signup\.js:44 no rate limit/);
  assert.match(out, new RegExp(`\\${SYMBOL.PENDING} ready for you`));
});

test('renderPoreia marks unparseable distinctly from both clean and blocking', () => {
  const view = {
    id: '2026-08-07-add-dark-mode',
    title: 'x',
    closed: false,
    cancelled: false,
    specWritten: true,
    planned: true,
    exploring: false,
    coder: { state: 'finished' },
    progress: null,
    steps: [],
    reviewRequested: true,
    checksOutcome: 'ok',
    review: {
      status: { state: 'finished' },
      findings: [],
      verdict: { source: 'none', verdict: null },
    },
    pushed: false,
    prUrl: null,
  };

  const out = renderPoreia(view);
  assert.match(out, /verdict: unparseable/);
  assert.doesNotMatch(out, /verdict: clean/);
});

test('renderPoreiaAll ranks needs-you above running above everything else', () => {
  const needsYou = {
    id: '2026-08-07-this-one-needs-you',
    cancelled: false,
    closed: false,
    reviewRequested: true,
    checksOutcome: 'ok',
    review: {
      status: { state: 'finished' },
      findings: [{ verdict: 'blocking', finding: 'x' }],
      verdict: { source: 'krisis', verdict: 'blocking' },
    },
    coder: { state: 'finished' },
    steps: [],
    position: 'review',
  };
  const running = {
    id: '2026-08-07-this-one-is-running',
    cancelled: false,
    closed: false,
    reviewRequested: false,
    checksOutcome: null,
    review: {
      status: { state: 'not-started' },
      findings: [],
      verdict: { source: 'not-done', verdict: null },
    },
    coder: { state: 'running' },
    steps: ['a'],
    position: 'code',
  };
  const idle = {
    id: '2026-08-07-this-one-is-idle',
    cancelled: false,
    closed: false,
    reviewRequested: false,
    checksOutcome: null,
    review: {
      status: { state: 'not-started' },
      findings: [],
      verdict: { source: 'not-done', verdict: null },
    },
    coder: { state: 'not-started' },
    steps: [],
    position: 'planning',
  };

  const out = renderPoreiaAll([idle, running, needsYou]);
  const order = out.split('\n').map((line) => line.split(' ')[0]);
  assert.deepEqual(order, [
    '2026-08-07-this-one-needs-you',
    '2026-08-07-this-one-is-running',
    '2026-08-07-this-one-is-idle',
  ]);
});

test('renderPoreiaAll reports no active tickets plainly, rather than an empty string', () => {
  assert.equal(renderPoreiaAll([]), 'no active tickets');
});

test('poreiaAll reads back every active ticket in one call', { concurrency: true }, async () => {
  const repoRoot = makeGitRepo();
  const stateDir = stateDirFor(repoRoot);
  await genesis({ repoRoot, stateDir, content: 'task 1' });
  await genesis({ repoRoot, stateDir, content: 'task 2' });

  const views = poreiaAll({ stateDir });
  assert.equal(views.length, 2);
});

// --------------------------------------------------------------------------- Aporia in poreia. A
// coder that stops on purpose and one that finished both exit with code 0. This view must show them as different. ---------------------------------------------------------------------------

test('poreia reads a recorded aporia back onto the view', { concurrency: true }, async () => {
  const repoRoot = makeGitRepo();
  const stateDir = stateDirFor(repoRoot);
  const ticket = await genesis({ repoRoot, stateDir, content: 'task', planContent: '1. do it' });
  recordAporia(stateDir, ticket.id, 'step 2 assumes a table that does not exist');

  const view = poreia({ stateDir, id: ticket.id });
  assert.equal(view.aporia!.reason, 'step 2 assumes a table that does not exist');
});

test('renderPoreia marks aporia as needs-you and stops before checks/review — nothing past it can happen yet', () => {
  const out = renderPoreia({
    id: '2026-08-07-add-dark-mode',
    title: 'x',
    closed: false,
    cancelled: false,
    specWritten: true,
    planned: true,
    exploring: false,
    coder: { state: 'finished' },
    progress: { commits: 1, uncommittedChanges: false },
    steps: ['step 1'],
    aporia: {
      reason: 'step 2 assumes a table that does not exist',
      at: '2026-01-01T00:00:00.000Z',
    },
    reviewRequested: false,
    checksOutcome: null,
    review: {
      status: { state: 'not-started' },
      findings: [],
      verdict: { source: 'not-done', verdict: null },
    },
    pushed: false,
    prUrl: null,
  });

  assert.match(out, new RegExp(`\\${SYMBOL.NEEDS_YOU} implement`));
  assert.match(out, /needs you — step 2 assumes a table that does not exist/);
  assert.doesNotMatch(out, /review/);
  assert.doesNotMatch(out, /ready for you/);
});

test('renderPoreiaAll ranks aporia the same as a blocking verdict — needs you, first', () => {
  const stuck = {
    id: '2026-08-07-this-one-is-stuck',
    cancelled: false,
    closed: false,
    aporia: { reason: 'blocked on a missing table' },
    reviewRequested: false,
    checksOutcome: null,
    review: {
      status: { state: 'not-started' },
      findings: [],
      verdict: { source: 'not-done', verdict: null },
    },
    coder: { state: 'finished' },
    steps: ['a'],
    position: 'code',
  };
  const idle = {
    id: '2026-08-07-this-one-is-idle',
    cancelled: false,
    closed: false,
    aporia: null,
    reviewRequested: false,
    checksOutcome: null,
    review: {
      status: { state: 'not-started' },
      findings: [],
      verdict: { source: 'not-done', verdict: null },
    },
    coder: { state: 'not-started' },
    steps: [],
    position: 'planning',
  };

  const out = renderPoreiaAll([idle, stuck]);
  assert.ok(out.split('\n')[0].startsWith('2026-08-07-this-one-is-stuck'));
});

// `ergon --status` is printed by glafka's own output and gets run on every ticket. It
// appended an `ergon` entry unconditionally, so after a clean round lastStageIndex(ERGON) became newer than lastStageIndex(REVIEW), isReviewedSinceLastChange flipped to false, and the clean verdict was voided.
test('--status after a review does not append an ergon entry over it', async () => {
  const stateDir = makeTempDir('status27');
  const id = '2026-08-07-add-search-filters';
  fs.mkdirSync(path.join(stateDir, 'tickets'), { recursive: true });
  const now = new Date().toISOString();
  writeTicket(stateDir, { id, created: now, updated: now });

  recordStage(stateDir, id, STAGES.ERGON, RUN_OUTCOMES.OK);
  recordStage(stateDir, id, STAGES.REVIEW, RUN_OUTCOMES.OK);
  assert.equal(isReviewedSinceLastChange(readTicket(stateDir, id)), true);

  // No run was ever spawned, so this is the "crashed"/"not-started" shape a
  // real --status call hits. It must not write over the review.
  await ergonStatus({ stateDir, id });

  assert.equal(
    isReviewedSinceLastChange(readTicket(stateDir, id)),
    true,
    'a clean round must survive being looked at',
  );
  fs.rmSync(stateDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

// The symbol used to come from the reviewer count alone, so a round with 0 of 1 back and no reviewer
// ever launched printed the RUNNING spinner beside `run=not-started`. The line contradicted itself.
test('the review symbol agrees with the run state printed beside it', () => {
  const base = {
    id: '2026-08-07-a-live-ticket',
    title: null,
    checksOutcome: null,
    aporia: null,
    coder: { state: 'finished' },
    steps: [{ subject: 'do a thing' }],
    progress: null,
    reviewRequested: true,
    pushed: false,
    prUrl: null,
  };
  const render = (state: string, back: number) =>
    renderPoreia({
      ...base,
      review: {
        status: { state },
        findings: [],
        verdict: { source: 'not-done', verdict: null, finding: null },
        back,
        total: 1,
      },
    } as unknown as Parameters<typeof renderPoreia>[0]);

  const notStarted = render('not-started', 0);
  assert.match(notStarted, /○ review {2}run=not-started/);
  assert.ok(!notStarted.includes('⣾ review'), 'a review that never started is not running');

  assert.match(render('running', 0), /⣾ review {2}run=running/);
  assert.match(render('finished', 1), /✔ review {2}run=finished/);
});

// --------------------------------------------------------------------------- "nothing ran".
// A ticket finished having run zero commands and read as clean. epistle refuses to push that now,
// so the hole is closed — but this line is where a person meets the fact, and `?` reads as
// uncertainty rather than something to act on. Nothing ran and nothing to run are different facts.

test('a ticket whose checks never ran is flagged as needing a person, not merely unknown', () => {
  const line = checksLine(RUN_OUTCOMES.CHECKS_UNKNOWN)!;

  assert.equal(line.symbol, SYMBOL.NEEDS_YOU);
  assert.match(line.label, /nothing ran/);
  // The consequence is the useful half: it says what will happen, not just what did not.
  assert.match(line.label, /cannot be pushed/);
});

test('passing and failing checks are unchanged', () => {
  assert.deepEqual(checksLine(RUN_OUTCOMES.OK), { symbol: SYMBOL.DONE, label: 'checks green' });
  assert.equal(checksLine(RUN_OUTCOMES.CHECKS_FAILED)!.symbol, SYMBOL.FAILED);
  assert.equal(checksLine(null), null);
});

// epistle refuses a commit made by hand after the review, so poreia must not say "ready".
test('poreia says a commit after the review needs you, not ready', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = path.join(repoRoot, '.glafka');
  const ticket = await genesis({ repoRoot, stateDir, content: 'task' });
  const worktree = ticket.worktree!;
  const commit = (file: string) => {
    fs.writeFileSync(path.join(worktree, file), 'x\n');
    execFileSync('git', ['add', file], { cwd: worktree });
    execFileSync('git', ['commit', '-q', '-m', file], { cwd: worktree });
  };
  commit('a.txt');
  const prepared = await ergonReview({
    stateDir,
    id: ticket.id,
    repoRoot,
    baseRef: 'main',
    checksCmd: 'true',
  });
  appendReviewFinding(stateDir, ticket.id, { verdict: 'clean', token: prepared.reviewToken });
  assert.equal(
    poreia({ stateDir, id: ticket.id }).unreviewedCommit,
    false,
    'HEAD is the reviewed code',
  );

  commit('b.txt');
  const view = poreia({ stateDir, id: ticket.id });
  assert.equal(view.unreviewedCommit, true);
  const out = renderPoreia(view);
  assert.doesNotMatch(out, /ready for you/);
  assert.match(out, new RegExp(`\\${SYMBOL.NEEDS_YOU} a commit no reviewer has read`));
  assert.match(renderPoreiaAll([view]), /needs you {2}— a commit no reviewer has read/);
});
