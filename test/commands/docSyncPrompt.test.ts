import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDocSyncPrompt } from '../../src/commands/epistle/epistle.js';

const PLAN = 'docs/glafka/tickets/2026-08-07-add-dark-mode/plan.md';
const SPEC = 'docs/glafka/tickets/2026-08-07-add-dark-mode/spec.md';

test('buildDocSyncPrompt embeds the ticket id, plan path, diff, and PR url', () => {
  const prompt = buildDocSyncPrompt({
    ticketId: '2026-08-07-add-dark-mode',
    planPath: PLAN,
    diff: 'diff --git a/health.js b/health.js\n+added\n',
    prUrl: 'https://github.com/example/repo/pull/9',
  });

  assert.match(prompt, /2026-08-07-add-dark-mode/);
  assert.match(prompt, new RegExp(PLAN));
  assert.match(prompt, /health\.js/);
  assert.match(prompt, /pull\/9/);
});

// The plan used to be pasted in full. On a real ticket that is most of the prompt, and paid twice:
// the agent opens the file anyway, because editing it in place is the whole job.
test('buildDocSyncPrompt sends the plan as a path to open, never its contents', () => {
  const prompt = buildDocSyncPrompt({
    ticketId: '2026-08-07-add-dark-mode',
    planPath: PLAN,
    diff: 'y',
  });

  assert.match(prompt, /not pasted here/);
  assert.match(prompt, /Open and read them/);
});

// The spec is what was ASKED for; the plan is what we said we would do about it. Without the spec
// the agent cannot tell that scope grew or shrank — but it is not the file being edited.
test('buildDocSyncPrompt offers the spec read-only, and names the plan as the only editable file', () => {
  const prompt = buildDocSyncPrompt({
    ticketId: '2026-08-07-add-dark-mode',
    planPath: PLAN,
    specPath: SPEC,
    diff: 'y',
  });

  assert.match(prompt, new RegExp(`read-only: ${SPEC}`));
  assert.match(prompt, /ONLY file\s+you edit: not the spec/);
});

// heureka and vima both make tickets that never had a spec.
test('buildDocSyncPrompt names no spec when the ticket has none', () => {
  const prompt = buildDocSyncPrompt({
    ticketId: '2026-08-07-add-dark-mode',
    planPath: PLAN,
    diff: 'y',
  });

  assert.doesNotMatch(prompt, /read-only:/);
  assert.doesNotMatch(prompt, /spec\.md/);
});

test('buildDocSyncPrompt asks to reconcile the plan against reality, not rewrite blindly', () => {
  const prompt = buildDocSyncPrompt({
    ticketId: '2026-08-07-add-dark-mode',
    planPath: PLAN,
    diff: 'y',
    prUrl: 'z',
  });

  assert.match(prompt, /Result/);
  assert.match(prompt, /change nothing/);
});

test('buildDocSyncPrompt handles an empty diff without a blank code block', () => {
  const prompt = buildDocSyncPrompt({
    ticketId: '2026-08-07-add-dark-mode',
    planPath: PLAN,
    diff: '   \n',
    prUrl: 'z',
  });

  assert.match(prompt, /no diff against base/);
});

// Doc sync runs unattended after the push, so there is no human whose words
// it could record. Asking it to anyway produced rules nobody ever said.
test('buildDocSyncPrompt does not ask for ethos — nobody is present at doc sync', () => {
  const prompt = buildDocSyncPrompt({
    ticketId: '2026-08-07-add-dark-mode',
    planPath: PLAN,
    diff: 'y',
    prUrl: 'z',
  });

  assert.doesNotMatch(prompt, /## Record what you learn/);
  assert.doesNotMatch(prompt, /glafka psyche/);
});
