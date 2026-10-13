import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  routeReview,
  explainRoute,
  roleFor,
  REVIEWER_KIND,
  MAX_REVIEWERS,
  LARGE_DIFF_FILES,
  LARGE_DIFF_LINES,
} from '../../src/commands/ergon/router.js';
import { resolveRoundVerdict } from '../../src/commands/ergon/utils.js';
import { VERDICT_SOURCE } from '../../src/commands/ergon/ergon.js';
import { buildReviewPrompt } from '../../src/commands/ergon/prompts.js';
import { reviewRoundCount } from '../../src/ticket/ticketStore.js';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// The router spends no tokens: it reads a file count and a line count.

test('a small green diff earns one general reviewer', () => {
  assert.deepEqual(routeReview({ files: 3, lines: 120 }), [REVIEWER_KIND.GENERAL]);
});

test('a diff over the file limit earns an architecture reviewer as well', () => {
  assert.deepEqual(routeReview({ files: LARGE_DIFF_FILES + 1, lines: 10 }), [
    REVIEWER_KIND.GENERAL,
    REVIEWER_KIND.ARCHITECTURE,
  ]);
});

test('a diff over the line limit earns one too, even with few files', () => {
  assert.deepEqual(routeReview({ files: 1, lines: LARGE_DIFF_LINES + 1 }), [
    REVIEWER_KIND.GENERAL,
    REVIEWER_KIND.ARCHITECTURE,
  ]);
});

// Exactly at the limit is not over it. Worth pinning: an off-by-one here
// silently doubles the cost of every medium diff.
test('a diff exactly at either limit still earns one reviewer', () => {
  assert.equal(routeReview({ files: LARGE_DIFF_FILES, lines: LARGE_DIFF_LINES }).length, 1);
});

test('the cap is never exceeded', () => {
  assert.ok(routeReview({ files: 10_000, lines: 1_000_000 }).length <= MAX_REVIEWERS);
});

// The first reviewer keeps the plain name. Everything written before fan-out
// looks for exactly "reviewer", so a one-reviewer round must be unchanged.
test('the first reviewer keeps the original role name', () => {
  assert.equal(roleFor(0), 'reviewer');
  assert.equal(roleFor(1), 'reviewer-1');
  assert.equal(roleFor(2), 'reviewer-2');
});

test('the route is explained in one line, with the real numbers', () => {
  assert.match(
    explainRoute({ files: 2, lines: 30 }, routeReview({ files: 2, lines: 30 })),
    /1 rev/,
  );
  const big = { files: 40, lines: 5000 };
  const note = explainRoute(big, routeReview(big));
  assert.match(note, /2 reviewers/);
  assert.match(note, /40 file/);
  assert.match(note, /5000 line/);
});

// glafka must not ship a guess about which folders are risky in someone
// else's project. This is the DEFAULT_RISK_AREAS lesson, kept as a test.
test('the router names no technology and no path', () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'src/commands/ergon/router.ts'), 'utf8');
  const code = source
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');

  for (const guess of ['alembic', 'prisma', 'migrations', 'auth', 'schema.rb', 'db/migrate']) {
    assert.equal(code.includes(guess), false, `router must not know about "${guess}"`);
  }
});

// --------------------------------------------------------------------------- Aggregating a verdict
// across several reviewers. ---------------------------------------------------------------------------

const done = { state: 'finished' } as never;
const running = { state: 'running' } as never;
const clean = [{ verdict: 'clean', verified: true }] as never;
const blocking = [{ verdict: 'blocking', finding: 'x' }] as never;

// The important one. A "clean" from the reviewer that finished first says
// nothing about the diff the other is still reading.
test('a round with one reviewer still running has no verdict yet', () => {
  const result = resolveRoundVerdict({ statuses: [done, running], findings: clean });
  assert.equal(result.source, VERDICT_SOURCE.NOT_DONE);
  assert.equal(result.verdict, null);
});

test('one blocking reviewer blocks the round', () => {
  const result = resolveRoundVerdict({ statuses: [done, done], findings: blocking });
  assert.equal(result.verdict, 'blocking');
});

test('a round is clean only when every reviewer is back and none objected', () => {
  assert.equal(resolveRoundVerdict({ statuses: [done, done], findings: clean }).verdict, 'clean');
});

// Silence is never read as agreement — that rule predates fan-out and must
// survive it.
test('a reviewer that recorded nothing readable keeps the round from being clean', () => {
  const crashed = { state: 'crashed' } as never;
  const result = resolveRoundVerdict({ statuses: [done, crashed], findings: clean });
  assert.notEqual(result.verdict, 'clean');
});

test('a round with no reviewers at all is not done', () => {
  assert.equal(resolveRoundVerdict({ statuses: [], findings: [] }).source, VERDICT_SOURCE.NOT_DONE);
});

// --------------------------------------------------------------------------- What each reviewer is
// worth paying for. ---------------------------------------------------------------------------

// Gap 1 from the plan: fan-out is free in resources but not in tokens. Two reviewers handed the same
// full context block cost twice as much and read no more. The map goes to whoever is reading for structure.
test('a solo general reviewer keeps the codebase map; a paired one gives it up', () => {
  const context = {
    personaContent: 'P',
    architectureIndex: 'THE-MAP',
    projectMemory: 'MEM',
    ethosContent: 'ETHOS',
  };
  const ticket = { id: '2026-08-07-add-dark-mode', specText: 'do it' };
  const build = (kind: string) => buildReviewPrompt({ ticket, diff: 'd', context, kind });

  // Alone, there is no duplication to avoid, so dropping the map would only
  // cost quality in the common case.
  assert.equal(build('general').includes('THE-MAP'), true);

  // Paired, the architecture reviewer is reading structure anyway.
  assert.equal(build('general-paired').includes('THE-MAP'), false);
  assert.equal(build('architecture').includes('THE-MAP'), true);

  // Both reviewers get the rules. The map is split to avoid paying twice for
  // the same reading; the rules are not, because each is asked to enforce them.
  assert.equal(build('general-paired').includes('ETHOS'), true);
  assert.equal(build('architecture').includes('ETHOS'), true);
});

test('the architecture reviewer is told not to redo the line-by-line review', () => {
  const prompt = buildReviewPrompt({
    ticket: { id: '2026-08-07-add-dark-mode', specText: 'do it' },
    diff: 'd',
    kind: 'architecture',
  });
  assert.match(prompt, /NOT the line-by-line reviewer/);
  assert.match(prompt, /for STRUCTURE/);
  // Finding nothing is a real answer — a padded finding costs more.
  assert.match(prompt, /say so plainly/);
});

// --------------------------------------------------------------------------- The review round
// budget. ---------------------------------------------------------------------------

// DECIDED 2026-08-04: count only rounds that followed new coder work. A re-review of unchanged code
// took a try away from the human for nothing, which matters more now that one round can collect several reviewers' worth of findings.
const stageLog = (...stages: string[]) =>
  ({ stageLog: stages.map((stage) => ({ at: '', stage, note: null })) }) as never;

test('a review round only counts once the coder has run again', () => {
  assert.equal(reviewRoundCount(stageLog('ergon', 'review')), 1);
  // Re-running --review changes nothing, so it costs nothing.
  assert.equal(reviewRoundCount(stageLog('ergon', 'review', 'review', 'review')), 1);
  assert.equal(reviewRoundCount(stageLog('ergon', 'review', 'ergon', 'review')), 2);
  assert.equal(reviewRoundCount(stageLog('ergon', 'review', 'review', 'ergon', 'review')), 2);
});

test('a ticket with no reviews yet has spent nothing', () => {
  assert.equal(reviewRoundCount(stageLog('create', 'plan', 'ergon')), 0);
});
