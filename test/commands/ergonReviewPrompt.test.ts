import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewPrompt } from '../../src/commands/ergon/prompts.js';

const TICKET = { id: '2026-08-07-add-dark-mode', specText: 'add a thing' };
const CONTEXT = {
  ethosContent: '- helpers that touch the parser stay in parser/',
  architectureIndex: 'src/ -> everything',
  categories: [],
};

function promptFor(kind: string): string {
  return buildReviewPrompt({
    ticket: TICKET,
    diff: 'diff --git a/x b/x',
    checks: [],
    checksNote: null,
    context: CONTEXT,
    kind,
  });
}

// The architecture and design rules are this reviewer's own subject. It was
// the one reviewer that never received them.
test('the architecture reviewer receives the project rules', () => {
  assert.match(promptFor('architecture'), /helpers that touch the parser stay in parser\//);
});

// Assert on the CHECKLIST heading, not on the words "project rules". Task 1
// renames the context header to "## Project rules (binding)", so a loose
// /project rules/i here would pass without the checklist ever being added.
test('the architecture checklist has its own rules section', () => {
  assert.match(promptFor('architecture'), /^## 3\. Project rules$/m);
  assert.match(promptFor('architecture'), /^## 4\. Shape of the change$/m);
  assert.match(promptFor('architecture'), /^## 5\. What it costs later$/m);
});

// A failing check is stated as blocking. A broken rule had no severity at
// all, so it defaulted to whatever the reviewer felt like.
//
// "blocking finding" alone is NOT a red: the checks line and the Output block
// both already say it today. Assert on the new sentence and on the hedge going.
test('a broken rule is stated as blocking, for every general reviewer', () => {
  for (const kind of ['general', 'general-paired']) {
    assert.match(promptFor(kind), /A rule is in force the same\s+way a check is/);
    assert.equal(
      promptFor(kind).includes('if that section is present'),
      false,
      `${kind} still hedges the rules question`,
    );
  }
});

test('every reviewer kind still receives the persona', () => {
  for (const kind of ['general', 'general-paired', 'architecture']) {
    assert.ok(promptFor(kind).length > 0);
  }
});

// The reviewer's persona also carries a reply template now, so both it and these
// instructions would otherwise shape the same text with nothing deciding which wins.
test('the reviewer persona shapes wording, never which sections there are', () => {
  const prompt = buildReviewPrompt({
    ticket: TICKET,
    diff: 'diff --git a/x b/x',
    checks: [],
    checksNote: null,
    context: { ...CONTEXT, personaContent: '- Short chunks, not paragraphs.' },
    kind: 'general',
  });

  assert.match(prompt, /Sections come from these instructions; wording comes from the style/);
  assert.match(prompt, /Never add, drop, or reorder a section/);
});
