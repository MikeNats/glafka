import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewPrompt } from '../../src/commands/ergon/ergon.js';
import { DEFAULT_CATEGORIES } from '../../src/memory/categories.js';

test('buildReviewPrompt embeds the ticket id, original ticket, and diff', () => {
  const prompt = buildReviewPrompt({
    ticket: { id: '2026-08-07-review-the-diff', specText: 'add a health check endpoint' },
    diff: 'diff --git a/health.js b/health.js\n+added\n',
  });

  assert.match(prompt, /2026-08-07-review-the-diff/);
  assert.match(prompt, /add a health check endpoint/);
  assert.match(prompt, /health\.js/);
});

test('buildReviewPrompt covers acceptance criteria, quality, security, and output format', () => {
  const prompt = buildReviewPrompt({
    ticket: { id: '2026-08-07-add-dark-mode', specText: 'x' },
    diff: 'some diff',
  });

  assert.match(prompt, /Acceptance criteria/);
  assert.match(prompt, /Code quality/);
  assert.match(prompt, /Security/);
  assert.match(prompt, /most severe first/);
});

test('buildReviewPrompt is plain text with no agent-specific tool references', () => {
  const prompt = buildReviewPrompt({
    ticket: { id: '2026-08-07-add-dark-mode', specText: 'x' },
    diff: 'y',
  });

  assert.doesNotMatch(prompt, /ReportFindings/);
  assert.doesNotMatch(prompt, /\bSkill\b/);
  assert.doesNotMatch(prompt, /Claude/i);
});

test('buildReviewPrompt handles an empty diff without leaving a blank code block', () => {
  const prompt = buildReviewPrompt({
    ticket: { id: '2026-08-07-add-dark-mode', specText: 'x' },
    diff: '   \n',
  });

  assert.match(prompt, /no staged changes/);
});

// If no checks ran, the prompt must say the change is not proven.
test('buildReviewPrompt calls an unchecked diff UNVERIFIED, not merely unscripted', () => {
  const prompt = buildReviewPrompt({
    ticket: { id: '2026-08-07-add-dark-mode', specText: 'x' },
    diff: 'y',
  });

  assert.match(prompt, /UNVERIFIED/);
  assert.match(prompt, /NONE RAN/);
  assert.match(prompt, /not treat this as a pass/i);
});

test('buildReviewPrompt passes the reason nothing ran through to the reviewer', () => {
  const prompt = buildReviewPrompt({
    ticket: { id: '2026-08-07-add-dark-mode', specText: 'x' },
    diff: 'y',
    checksNote: 'this is a monorepo (pnpm-workspace.yaml) — set "checksCmd" in .glafka.json',
  });

  assert.match(prompt, /monorepo \(pnpm-workspace\.yaml\)/);
  assert.match(prompt, /checksCmd/);
});

test('buildReviewPrompt surfaces check results, marking failures clearly', () => {
  const prompt = buildReviewPrompt({
    ticket: { id: '2026-08-07-add-dark-mode', specText: 'x' },
    diff: 'y',
    checks: [
      { name: 'lint', passed: true, output: '0 problems\n' },
      { name: 'test', passed: false, output: '1 failing\n  should add up\n' },
    ],
  });

  assert.match(prompt, /lint: PASSED/);
  assert.match(prompt, /test: FAILED/);
  assert.match(prompt, /1 failing/);
  assert.match(prompt, /blocking finding/);
});

// A passing check does not need its full output shown.
test("buildReviewPrompt drops a passing check's stdout entirely", () => {
  const prompt = buildReviewPrompt({
    ticket: { id: '2026-08-07-add-dark-mode', specText: 'x' },
    diff: 'y',
    checks: [{ name: 'lint', passed: true, output: '0 problems\nchecked 412 files\n' }],
  });

  assert.match(prompt, /### lint: PASSED/);
  assert.doesNotMatch(prompt, /checked 412 files/);
});

// Keep the end of long output, not the start.
test('buildReviewPrompt keeps the TAIL of a long failing check, not the head', () => {
  const lines = Array.from({ length: 250 }, (_, i) => `line ${i + 1}`);
  const prompt = buildReviewPrompt({
    ticket: { id: '2026-08-07-add-dark-mode', specText: 'x' },
    diff: 'y',
    checks: [{ name: 'test', passed: false, output: lines.join('\n') }],
  });

  assert.doesNotMatch(prompt, /line 1\n/);
  assert.match(prompt, /line 250/);
  assert.match(prompt, /50 earlier line\(s\) omitted/);
});

test('buildReviewPrompt leaves a short failing check untouched, with no omission note', () => {
  const prompt = buildReviewPrompt({
    ticket: { id: '2026-08-07-add-dark-mode', specText: 'x' },
    diff: 'y',
    checks: [{ name: 'test', passed: false, output: '1 failing\n  should add up\n' }],
  });

  assert.doesNotMatch(prompt, /earlier line\(s\) omitted/);
  assert.match(prompt, /should add up/);
});

test('buildReviewPrompt omits project-memory/ethos/map sections entirely when absent', () => {
  const prompt = buildReviewPrompt({
    ticket: { id: '2026-08-07-add-dark-mode', specText: 'x' },
    diff: 'y',
  });

  assert.doesNotMatch(prompt, /## Project memory/);
  assert.doesNotMatch(prompt, /## Project rules/);
  assert.doesNotMatch(prompt, /## Codebase map/);
});

test('buildReviewPrompt includes the codebase map when odysse has been run', () => {
  const prompt = buildReviewPrompt({
    ticket: { id: '2026-08-07-add-dark-mode', specText: 'x' },
    diff: 'y',
    context: { architectureIndex: '- src/commands/ — one file per CLI command' },
  });

  assert.match(prompt, /## Codebase map/);
  assert.match(prompt, /```\n- src\/commands\/ — one file per CLI command\n```/);
});

test('buildReviewPrompt includes project memory and project rules when given', () => {
  const prompt = buildReviewPrompt({
    ticket: { id: '2026-08-07-add-dark-mode', specText: 'x' },
    diff: 'y',
    context: {
      projectMemory: 'this project uses uv for dependency management',
      ethosContent: '- prefer composition over inheritance',
    },
  });

  assert.match(prompt, /## Project memory\nthis project uses uv/);
  assert.match(prompt, /## Project rules[\s\S]*- prefer composition over inheritance/);
});

// This is not the final learning step. Another step runs later too.
test('buildReviewPrompt does not capture ethos — a reviewer runs with nobody watching', () => {
  const prompt = buildReviewPrompt({
    ticket: { id: '2026-08-07-fix-the-login-bypass', specText: 'add a health check' },
    diff: '+ ok',
    context: { categories: DEFAULT_CATEGORIES },
  });

  assert.doesNotMatch(prompt, /## Record what you learn/);
  assert.doesNotMatch(prompt, /glafka psyche/);
});

// --------------------------------------------------------------------------- Tests that review
// findings stay clear and detailed for a person to read. ---------------------------------------------------------------------------

test('buildReviewPrompt carries the active persona', () => {
  const prompt = buildReviewPrompt({
    ticket: { id: '2026-08-07-add-dark-mode', specText: 'x' },
    diff: 'y',
    context: { personaContent: '- Bullets, not dense prose.' },
  });

  assert.match(prompt, /## Persona/);
  assert.match(prompt, /Bullets, not dense prose/);
});

// Even a short style must keep the file, line, and reason.
// Without these, the finding can't be fixed.
test('buildReviewPrompt refuses to let a shorter style drop the detail of a finding', () => {
  const prompt = buildReviewPrompt({
    ticket: { id: '2026-08-07-add-dark-mode', specText: 'x' },
    diff: 'y',
    context: { personaContent: '- Short chunks. One idea per line.' },
  });

  assert.match(prompt, /its file, its line, and why it matters/);
  assert.match(prompt, /never cost a detail someone needs in order to act/);
});

test('buildReviewPrompt stops a persona turning a review into a question or a redesign', () => {
  const prompt = buildReviewPrompt({
    ticket: { id: '2026-08-07-add-dark-mode', specText: 'x' },
    diff: 'y',
    context: { personaContent: '- Lead with what if. Name 2-3 different directions.' },
  });

  assert.match(prompt, /Do not ask a question in place of stating a finding/);
  assert.match(prompt, /Do not propose an alternative design in place of naming a defect/);
});

test('buildReviewPrompt omits the persona section entirely when none is active', () => {
  const prompt = buildReviewPrompt({
    ticket: { id: '2026-08-07-add-dark-mode', specText: 'x' },
    diff: 'y',
  });

  assert.doesNotMatch(prompt, /## Persona/);
});

// --------------------------------------------------------------------------- The prompt must tell
// the reviewer how to report findings. ---------------------------------------------------------------------------

test('buildReviewPrompt tells the agent to report findings through glafka krisis', () => {
  const prompt = buildReviewPrompt({
    ticket: { id: '2026-08-07-fix-the-login-bypass', specText: 'x' },
    diff: 'y',
  });

  assert.match(
    prompt,
    /glafka krisis 2026-08-07-fix-the-login-bypass --verdict blocking --finding/,
  );
  assert.match(prompt, /One call per finding/);
  assert.match(prompt, /--verdict clean/);
});

// A reviewer may not be able to run the report command.
// So a VERDICT line in plain text is always required.
test('buildReviewPrompt requires a VERDICT line regardless of whether krisis is available', () => {
  const prompt = buildReviewPrompt({
    ticket: { id: '2026-08-07-add-dark-mode', specText: 'x' },
    diff: 'y',
  });

  assert.match(prompt, /VERDICT: clean/);
  assert.match(prompt, /VERDICT: blocking/);
  assert.match(prompt, /not optional/);
  assert.match(prompt, /even if you already called `krisis`/);
});

// Old bug: a huge diff was never trimmed down, which could overflow the
// reviewer's limits. Fixed once by truncating it — but a
// truncated diff quietly dropped files from review, and the full prompt
// (diff + architecture map + ethos + standards + plan) could still overflow
// even when the diff itself fit. Now an oversized diff is never pasted in at
// all: the reviewer already runs with shell access in the worktree, so it
// reads the real thing itself instead of a partial copy.
test('an oversized diff is never pasted in — the reviewer is told to read it itself', () => {
  const huge = Array.from({ length: 60_000 }, (_, i) => `+ line ${i}`).join('\n');
  const prompt = buildReviewPrompt({
    ticket: { id: '2026-08-02-cage-the-coder', specText: 'do the thing' },
    diff: huge,
    baseRef: 'main',
    checks: [],
    checksNote: null,
    hostExec: null,
    reviewToken: null,
  });

  assert.ok(prompt.length < huge.length, 'the diff must not go in whole');
  assert.match(prompt, /git diff --submodule=diff main\.\.\.HEAD/);
  assert.doesNotMatch(prompt, /\+ line 0\n/, 'no line of the actual diff should be pasted in');
});

// Without a baseRef there is no command to hand the reviewer, so the old
// truncate-and-embed behaviour is the only thing left that still works.
test('an oversized diff with no baseRef falls back to a truncated embed', () => {
  const huge = Array.from({ length: 60_000 }, (_, i) => `+ line ${i}`).join('\n');
  const prompt = buildReviewPrompt({
    ticket: { id: '2026-08-02-cage-the-coder', specText: 'do the thing' },
    diff: huge,
    checks: [],
    checksNote: null,
    hostExec: null,
    reviewToken: null,
  });

  assert.ok(prompt.length < huge.length, 'the diff must not go in whole');
  assert.match(prompt, /\+ line 0\n/, 'falls back to embedding what it can');
});

test('an ordinary diff is passed through untouched', () => {
  const diff = 'diff --git a/src/a.ts b/src/a.ts\n+const a = 1;\n';
  const prompt = buildReviewPrompt({
    ticket: { id: '2026-08-02-cage-the-coder', specText: 'do the thing' },
    diff,
    checks: [],
    checksNote: null,
    hostExec: null,
    reviewToken: null,
  });

  assert.ok(prompt.includes(diff));
  assert.doesNotMatch(prompt, /earlier line\(s\) omitted/);
});
