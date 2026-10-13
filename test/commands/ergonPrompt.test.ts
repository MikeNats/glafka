import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildErgonPrompt } from '../../src/commands/ergon/ergon.js';
import { DEFAULT_CATEGORIES } from '../../src/memory/categories.js';

test('buildErgonPrompt embeds the ticket id and plan content', () => {
  const prompt = buildErgonPrompt({
    ticket: { id: '2026-08-07-add-dark-mode' },
    planContent: '1. add the health route',
  });

  assert.match(prompt, /2026-08-07-add-dark-mode/);
  assert.match(prompt, /add the health route/);
});

test('buildErgonPrompt always points the agent at .env.glafka', () => {
  const prompt = buildErgonPrompt({
    ticket: { id: '2026-08-07-add-dark-mode' },
    planContent: 'x',
  });

  assert.match(prompt, /\.env\.glafka/);
  assert.match(prompt, /rather than using this project's normal defaults/);
});

// glafka picked the ports. The prompt says them clearly, no guessing.

test('buildErgonPrompt names the exact ports this ticket was given', () => {
  const prompt = buildErgonPrompt({
    ticket: {
      id: '2026-08-07-add-dark-mode',
      isolationPorts: { db: 4196, server: 4124, client: 4199 },
    },
    planContent: 'x',
  });

  assert.match(prompt, /Your ports for this ticket:\*\* db=4196 · server=4124 · client=4199/);
  assert.match(prompt, /another ticket may hold them/);
});

test('buildErgonPrompt states a single reserved port for a project with no services', () => {
  const prompt = buildErgonPrompt({
    ticket: { id: '2026-08-07-add-dark-mode', port: 4137 },
    planContent: 'x',
  });

  assert.match(prompt, /Your ports for this ticket:\*\* PORT=4137/);
});

test('buildErgonPrompt never hedges about whether an isolation profile exists', () => {
  for (const args of [
    { ticket: { id: '2026-08-07-add-dark-mode' }, planContent: 'x' },
    { ticket: { id: '2026-08-07-add-dark-mode', port: 4137 }, planContent: 'x' },
    { ticket: { id: '2026-08-07-add-dark-mode', isolationPorts: { db: 4196 } }, planContent: 'x' },
  ]) {
    assert.doesNotMatch(buildErgonPrompt(args), /if this project\s+has an isolation profile/);
  }
});

// A ticket with no ports yet should still look fine, not show an empty list.
test('buildErgonPrompt degrades cleanly when no ports were reserved', () => {
  const prompt = buildErgonPrompt({
    ticket: { id: '2026-08-07-add-dark-mode', isolationPorts: {} },
    planContent: 'x',
  });

  assert.doesNotMatch(prompt, /Your ports for this ticket/);
  assert.match(prompt, /whatever this project's\s+setup reserved for this ticket/);
});

test('buildErgonPrompt requires test-first and per-step verification', () => {
  const prompt = buildErgonPrompt({
    ticket: { id: '2026-08-07-add-dark-mode' },
    planContent: 'x',
  });

  assert.match(prompt, /failing test first/);
  assert.match(prompt, /Verify before moving on/);
  assert.match(prompt, /Commit after each step/);
});

// The prompt names the skills it wants, because a coder that paraphrases them from
// memory is not running them. What it must never name is one harness's tools — the
// same string ships to every platform, and to `GLAFKA_AGENT_CMD` processes too.
test('buildErgonPrompt names no harness-specific tool', () => {
  const prompt = buildErgonPrompt({
    ticket: { id: '2026-08-07-add-dark-mode' },
    planContent: 'x',
  });

  assert.doesNotMatch(prompt, /\bSkill\(/);
  assert.doesNotMatch(prompt, /\bAgent\(/);
  assert.doesNotMatch(prompt, /activate_skill|run_shell_command/);
  assert.doesNotMatch(prompt, /Claude/i);
});

// A coder on a harness with no skill tool, or a project without Superpowers installed,
// still has to be told how to work. That's what the bullets are for, so they stay.
test('buildErgonPrompt still carries the plain-text instructions the skills would give', () => {
  const prompt = buildErgonPrompt({
    ticket: { id: '2026-08-07-add-dark-mode' },
    planContent: 'x',
  });

  assert.match(prompt, /executing-plans/);
  assert.match(prompt, /failing test first/);
  assert.match(prompt, /Verify before moving on/);
  assert.match(prompt, /same instructions in plain text/);
});

test('buildErgonPrompt omits spec/project-memory/ethos/map sections entirely when absent', () => {
  const prompt = buildErgonPrompt({
    ticket: { id: '2026-08-07-add-dark-mode' },
    planContent: 'x',
  });

  assert.doesNotMatch(prompt, /## Original ticket/);
  assert.doesNotMatch(prompt, /## Project memory/);
  assert.doesNotMatch(prompt, /## Project rules/);
  assert.doesNotMatch(prompt, /## Codebase map/);
});

test('buildErgonPrompt includes the codebase map when odysse has been run', () => {
  const prompt = buildErgonPrompt({
    ticket: { id: '2026-08-07-add-dark-mode' },
    planContent: 'x',
    context: { architectureIndex: '- src/commands/ — one file per CLI command' },
  });

  assert.match(prompt, /## Codebase map/);
  assert.match(prompt, /```\n- src\/commands\/ — one file per CLI command\n```/);
});

test('buildErgonPrompt states the worktree path explicitly when given, omits the section when not', () => {
  const withPath = buildErgonPrompt({
    ticket: {
      id: '2026-08-07-add-dark-mode',
      worktree: '/repo/.worktrees/2026-08-07-add-dark-mode',
    },
    planContent: 'x',
  });
  const withoutPath = buildErgonPrompt({
    ticket: { id: '2026-08-07-add-dark-mode' },
    planContent: 'x',
  });

  assert.match(
    withPath,
    /## Where to work\nYour worktree is at `\/repo\/\.worktrees\/2026-08-07-add-dark-mode`/,
  );
  assert.doesNotMatch(withoutPath, /## Where to work/);
});

test('buildErgonPrompt includes the spec, project memory, and project rules when given', () => {
  const prompt = buildErgonPrompt({
    ticket: { id: '2026-08-07-add-dark-mode', specText: 'add a health check endpoint' },
    planContent: '1. add the route',
    context: {
      projectMemory: 'this project uses uv for dependency management',
      ethosContent: '- prefer composition over inheritance',
    },
  });

  assert.match(prompt, /## Original ticket \(what was asked for\)\nadd a health check endpoint/);
  assert.match(prompt, /## Project memory\nthis project uses uv/);
  assert.match(prompt, /## Project rules[\s\S]*- prefer composition over inheritance/);
});

// The coder must also write down what it learns, not just read old notes.
test('buildErgonPrompt does not ask the coder to record rules — nobody is there to state one', () => {
  const prompt = buildErgonPrompt({
    ticket: { id: '2026-08-07-fix-the-login-bypass' },
    planContent: '1. add the route',
    context: { categories: DEFAULT_CATEGORIES },
  });

  assert.doesNotMatch(prompt, /## Record what you learn/);
  assert.doesNotMatch(prompt, /glafka psyche/);

  // Review runs after coding, so this is not the last step.
  assert.doesNotMatch(prompt, /last stage that records anything/);
});

// glafka starts the reviewer itself. The coder cannot do this,
// so the prompt must say that clearly.
test("buildErgonPrompt's own last step tells the agent glafka spawns the reviewer, not the agent itself", () => {
  const prompt = buildErgonPrompt({
    ticket: { id: '2026-08-07-fix-the-login-bypass' },
    planContent: 'x',
  });

  assert.match(prompt, /glafka ergon 2026-08-07-fix-the-login-bypass --review/);
  assert.match(prompt, /glafka spawns it itself/);
  assert.match(prompt, /--review --status/);
  // Tells the agent this skill is not needed, so it does not try it out of habit.
  assert.match(prompt, /do not need a\s*`requesting-code-review` skill/);
});

// If no reviewer is set up, the prompt must say the coder's job ends
// after handing off the brief. It must not pretend a skill will review it.
test('buildErgonPrompt tells the agent it cannot spawn a reviewer itself, either', () => {
  const prompt = buildErgonPrompt({
    ticket: { id: '2026-08-07-fix-the-login-bypass' },
    planContent: 'x',
  });

  assert.match(prompt, /you have no way to spawn a fresh reviewer yourself/);
});

// No PR is ever made automatically. Pushing should not look like
// the normal next step after a clean review.
test('buildErgonPrompt never tells the agent to push or open a PR', () => {
  const prompt = buildErgonPrompt({
    ticket: { id: '2026-08-07-add-dark-mode' },
    planContent: 'x',
  });

  assert.match(prompt, /[Pp]ushing is a separate, later decision/);
  assert.doesNotMatch(prompt, /open a PR/i);
  assert.doesNotMatch(prompt, /\bepistle\b/i);
});

// Persona. The coder writes code, then a report. Style only affects the report.

test('buildErgonPrompt carries the active persona', () => {
  const prompt = buildErgonPrompt({
    ticket: { id: '2026-08-07-add-dark-mode' },
    planContent: '1. do it',
    context: { personaContent: '- Short chunks, not paragraphs.' },
  });

  assert.match(prompt, /## Persona/);
  assert.match(prompt, /Short chunks, not paragraphs/);
});

// Without this rule, persona style could leak into code, like Greek variable names.
test('buildErgonPrompt scopes the persona to prose, never to code', () => {
  const prompt = buildErgonPrompt({
    ticket: { id: '2026-08-07-add-dark-mode' },
    planContent: '1. do it',
    context: { personaContent: '- Respond in Greek.' },
  });

  assert.match(prompt, /ONLY text a person will read/);
  assert.match(
    prompt,
    /does NOT apply to code, comments,\s*commit messages, test names, or identifiers/,
  );
});

// Some personas ask questions or suggest other ways to do things.
// That breaks a run with no one watching, so the prompt turns this off.
test('buildErgonPrompt overrides the personas that would derail an unattended run', () => {
  const prompt = buildErgonPrompt({
    ticket: { id: '2026-08-07-add-dark-mode' },
    planContent: '1. do it',
    context: { personaContent: '- Before giving a full answer, ask one small guiding question.' },
  });

  assert.match(prompt, /Do not ask the requester questions/);
  assert.match(prompt, /There is no one to answer them/);
  assert.match(prompt, /Do not offer alternative approaches/);
  assert.match(prompt, /already approved/);
});

test('buildErgonPrompt omits the persona section entirely when none is active', () => {
  const prompt = buildErgonPrompt({
    ticket: { id: '2026-08-07-add-dark-mode' },
    planContent: '1. do it',
  });

  assert.doesNotMatch(prompt, /## Persona/);
  assert.doesNotMatch(prompt, /ONLY text a person will read/);
});

// The coder must be told the exact check command, not left to guess it.

test('buildErgonPrompt states the exact check command when one is configured', () => {
  const prompt = buildErgonPrompt({
    ticket: { id: '2026-08-07-add-dark-mode' },
    planContent: 'x',
    checksCmd: 'uv run pytest && uv run mypy .',
  });

  assert.match(prompt, /run exactly this and see it\s*exit 0 — `uv run pytest && uv run mypy \.`/);
  assert.match(prompt, /Do not substitute your own command/);
});

test('buildErgonPrompt names e2eCmd separately from checksCmd, when both are configured', () => {
  const prompt = buildErgonPrompt({
    ticket: { id: '2026-08-07-add-dark-mode' },
    planContent: 'x',
    checksCmd: 'pytest',
    e2eCmd: 'playwright test',
  });

  assert.match(prompt, /e2e is separate: `playwright test`/);
});

// If there is no checksCmd, the prompt says so, instead of making one up.
test('buildErgonPrompt admits honestly when no checksCmd is configured, rather than guessing one', () => {
  const prompt = buildErgonPrompt({
    ticket: { id: '2026-08-07-add-dark-mode' },
    planContent: 'x',
  });

  assert.match(prompt, /no `checksCmd` is\s*configured for this project/);
  assert.doesNotMatch(prompt, /exit 0 — `/);
});

// aporia means "stuck". Without it, a coder that gave up would look
// the same as one that finished.

test("buildErgonPrompt tells the coder to record an impasse through glafka aporia, not just 'say so'", () => {
  const prompt = buildErgonPrompt({
    ticket: { id: '2026-08-07-fix-the-login-bypass' },
    planContent: 'x',
  });

  assert.match(prompt, /glafka aporia 2026-08-07-fix-the-login-bypass --reason/);
  assert.match(prompt, /looks identical to one that finished/);
});

// A coder running in the background is still "running" until it stops.
// It must not try to review its own run while still live.

test('buildErgonPrompt tells a backgrounded coder to stop, not to review itself', () => {
  const prompt = buildErgonPrompt({
    ticket: { id: '2026-08-07-add-dark-mode' },
    planContent: 'x',
    background: true,
  });

  assert.doesNotMatch(prompt, /don't stop yet/);
  assert.doesNotMatch(prompt, /you have no way to spawn a fresh reviewer yourself/);
  assert.match(prompt, /stop here — do not run\s*`glafka ergon 2026-08-07-add-dark-mode --review`/);
  assert.match(prompt, /considers "running" until it exits/);
  assert.match(prompt, /[Pp]ushing is a separate, later decision/);
});

test("buildErgonPrompt's foreground instructions (background not set) are unchanged", () => {
  const prompt = buildErgonPrompt({
    ticket: { id: '2026-08-07-add-dark-mode' },
    planContent: 'x',
  });

  assert.match(prompt, /don't stop yet — run/);
  assert.match(prompt, /glafka ergon 2026-08-07-add-dark-mode --review/);
});

// --------------------------------------------------------------------------- The report's shape.
// The prompt used to specify a report as "Clean: stop and report", so every run invented its own.
// One real report buried "the review never ran" in fourth place, under two sections of detail — a
// person had to read all of it to learn they had to act.

test('buildErgonPrompt names every section the report must have', () => {
  const prompt = buildErgonPrompt({
    ticket: { id: '2026-08-07-add-dark-mode' },
    planContent: '1. do it',
  });

  for (const section of [
    'Status:',
    'Blocked on',
    'Changed',
    'Evidence',
    'Off-plan',
    'Not done',
    'Found, not fixed',
  ]) {
    assert.ok(prompt.includes(section), `the report shape is missing "${section}"`);
  }
});

// The ordering rule is the fix. Without it the shape is just a list of headings.
test('buildErgonPrompt puts the blocker above the detail, and says so', () => {
  const prompt = buildErgonPrompt({
    ticket: { id: '2026-08-07-add-dark-mode' },
    planContent: '1. do it',
  });

  assert.match(prompt, /Status first, blocker second/);
  assert.ok(
    prompt.indexOf('**Blocked on**') < prompt.indexOf('**Changed**'),
    'the blocked section must come before what changed',
  );
});

// Optional sections are the ones that quietly disappear, and these two are exactly
// the ones a person needs: what was done off-plan, and what was left behind.
test('off-plan and found-not-fixed are required sections, with "nothing" allowed', () => {
  const prompt = buildErgonPrompt({
    ticket: { id: '2026-08-07-add-dark-mode' },
    planContent: '1. do it',
  });

  assert.match(prompt, /Off-plan and "found, not fixed" are required/);
  assert.match(prompt, /"nothing" is a fine answer/);
});

// A persona carries its own reply template now, so the two would otherwise compete
// for the same text with nothing deciding which wins.
test('the persona is told it shapes wording, never which sections there are', () => {
  const prompt = buildErgonPrompt({
    ticket: { id: '2026-08-07-add-dark-mode' },
    planContent: '1. do it',
    context: { personaContent: '- Short chunks, not paragraphs.' },
  });

  assert.match(prompt, /Sections come from these instructions; wording comes from the style/);
  assert.match(prompt, /Never add, drop, or reorder a section/);
});

// The plan is the snapshot of what was agreed. Decisions are what was settled
// after it, so they come later in the prompt and win where they disagree.

test('decisions come after the plan and say they win', () => {
  const prompt = buildErgonPrompt({
    ticket: { id: '2026-08-14-a-ticket' },
    planContent: '## Task 1: do the thing',
    decisionsContent: '## Person decisions\n\n- no lat/lon input\n',
  });

  assert.ok(prompt.indexOf('## Plan') < prompt.indexOf('## Decisions taken since'));
  assert.match(prompt, /no lat\/lon input/);
  assert.match(prompt, /the decision wins/);
});

test('the decisions section tells the coder how to add its own', () => {
  const prompt = buildErgonPrompt({
    ticket: { id: '2026-08-14-a-ticket' },
    planContent: '## Task 1: do the thing',
    decisionsContent: '## Person decisions\n\n- no lat/lon input\n',
    cli: 'node .glafka/bin/glafka.js',
  });

  assert.match(prompt, /node \.glafka\/bin\/glafka\.js apofasi 2026-08-14-a-ticket/);
});

test('no decisions means no decisions section', () => {
  const prompt = buildErgonPrompt({
    ticket: { id: '2026-08-14-a-ticket' },
    planContent: '## Task 1: do the thing',
  });

  assert.doesNotMatch(prompt, /## Decisions taken since/);
});
