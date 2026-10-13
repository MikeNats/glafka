import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRawReport, buildLogosPrompt } from '../../src/commands/logos/logos.js';
import type { PoreiaView } from '../../src/commands/poreia/utils.js';
import { VERDICT_SOURCE } from '../../src/commands/ergon/ergon.js';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// A view with nothing happening. Each test overrides only what it is about.
function view(overrides: Partial<PoreiaView> = {}): PoreiaView {
  return {
    id: '2026-08-02-cage-the-coder',
    title: 'add search filters',
    position: 'reviewed',
    closed: false,
    cancelled: false,
    specWritten: true,
    planned: true,
    exploring: false,
    coder: { state: 'finished' },
    progress: { commits: 2 },
    steps: ['step one', 'step two'],
    aporia: null,
    reviewRequested: true,
    reviewedAt: '2026-08-04T00:00:00.000Z',
    unreviewedCommit: false,
    checksOutcome: 'ok',
    devRunning: null,
    review: {
      status: { state: 'finished' },
      findings: [],
      verdict: { source: VERDICT_SOURCE.KRISIS, verdict: 'clean' },
    },
    pushed: false,
    branchPushed: false,
    prUrl: null,
    ...overrides,
  };
}

// The raw report is the fallback for every failure path, so it has to stand
// on its own without an LLM ever running.

test('the raw report carries the work, the checks and the verdict', () => {
  const report = buildRawReport(view());

  assert.match(report, /2026-08-02-cage-the-coder/);
  assert.match(report, /add search filters/);
  assert.match(report, /- step one/);
  assert.match(report, /- step two/);
  assert.match(report, /Checks: checks green/);
  assert.match(report, /verdict: clean/);
  assert.match(report, /Not pushed/);
});

test('a blocking finding appears with its detail, not just a count', () => {
  const report = buildRawReport(
    view({
      review: {
        status: { state: 'finished' },
        findings: [
          { verdict: 'blocking', finding: 'src/a.ts:12 — unchecked null' },
          { verdict: 'clean', finding: null },
        ],
        verdict: { source: VERDICT_SOURCE.KRISIS, verdict: 'blocking' },
      },
    }),
  );

  assert.match(report, /Blocking findings \(1\)/);
  assert.match(report, /src\/a\.ts:12 — unchecked null/);
});

// A coder that stopped on purpose outranks everything else: nothing moves
// until a person answers, so the report must not bury it under check results.
test('a stop reason ends the report and is stated plainly', () => {
  const report = buildRawReport(view({ aporia: { reason: 'the plan names a file that is gone' } }));

  assert.match(report, /STOPPED ON PURPOSE/);
  assert.match(report, /the plan names a file that is gone/);
  assert.equal(report.includes('Checks:'), false, 'nothing after the stop reason');
});

test('checks that never ran are never reported as passing', () => {
  const report = buildRawReport(view({ checksOutcome: null }));
  assert.match(report, /Checks: not run yet/);
  assert.equal(/green/.test(report), false);
});

test('a review still running is not reported as a verdict', () => {
  const report = buildRawReport(
    view({
      review: {
        status: { state: 'running' },
        findings: [],
        verdict: { source: VERDICT_SOURCE.NOT_DONE },
      },
    }),
  );
  assert.match(report, /Review: still running/);
  assert.equal(/verdict:/.test(report), false);
});

test('a cancelled or closed ticket reports that and stops', () => {
  assert.match(buildRawReport(view({ cancelled: true })), /Cancelled\./);

  const closed = buildRawReport(
    view({ closed: true, pushed: true, prUrl: 'https://example.test/pr/1' }),
  );
  assert.match(closed, /Closed\./);
  assert.match(closed, /https:\/\/example\.test\/pr\/1/);
});

test('a ticket with no commits says so rather than showing an empty list', () => {
  assert.match(buildRawReport(view({ steps: [] })), /nothing committed yet/);
});

// The reporter re-renders. It is not a second reviewer, and it has no way to
// check anything it would add.
test('the prompt forbids adding to the report and demands every fact survives', () => {
  const prompt = buildLogosPrompt({ report: 'the report', personaContent: null });

  assert.match(prompt, /not reviewing the work/);
  assert.match(prompt, /Add nothing/);
  assert.match(prompt, /must survive/);
  assert.match(prompt, /the report/);
});

test('the persona shapes the prompt when one is active', () => {
  const withPersona = buildLogosPrompt({ report: 'r', personaContent: '- bullets, not prose' });
  assert.match(withPersona, /- bullets, not prose/);

  // With no persona there is still a style, so output does not drift.
  assert.match(buildLogosPrompt({ report: 'r' }), /## Write it this way/);
});

// The binding rule from the plan: logos costs tokens, and vima/poreia are the zero-token paths. A
// cron `vima --all` that called it once per ticket per tick is the exact cost this project refuses.
test('logos is not called from vima or poreia', () => {
  for (const rel of [
    'src/commands/vima/vima.ts',
    'src/commands/poreia/poreia.ts',
    'installKit/bin/commands/vima.ts',
    'installKit/bin/commands/poreia.ts',
  ]) {
    const source = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    assert.equal(/logos/.test(source), false, `${rel} must not reach for logos`);
  }
});

test('a commit after the review is stated under the verdict', () => {
  const report = buildRawReport(view({ unreviewedCommit: true }));
  assert.match(report, /verdict: clean/);
  assert.match(report, /After this review: a commit no reviewer has read\./);
});
