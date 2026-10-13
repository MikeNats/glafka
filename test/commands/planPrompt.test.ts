import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlanPrompt } from '../../src/commands/genesis/genesis.js';
import { DEFAULT_CATEGORIES } from '../../src/memory/categories.js';

test('buildPlanPrompt embeds the approved spec content', () => {
  const prompt = buildPlanPrompt('Spec: add a health check endpoint that returns 200.');

  assert.match(prompt, /add a health check endpoint that returns 200/);
});

test('buildPlanPrompt asks for ordered steps and test-first ordering, not code', () => {
  const prompt = buildPlanPrompt('x');

  assert.match(prompt, /Ordered steps/);
  assert.match(prompt, /test/i);
  assert.match(prompt, /Do not\s+write any code yet/i);
});

test('buildPlanPrompt is plain text with no agent-specific tool references', () => {
  const prompt = buildPlanPrompt('x');

  assert.doesNotMatch(prompt, /superpowers/i);
  assert.doesNotMatch(prompt, /\bSkill\b/);
  assert.doesNotMatch(prompt, /Claude/i);
});

// A person can also push back on the scope here.
test('buildPlanPrompt tells the agent to record ethos when a ticket id is given, omits it when not', () => {
  const withId = buildPlanPrompt('x', {
    ticketId: '2026-08-07-add-dark-mode',
    categories: DEFAULT_CATEGORIES,
  });
  const withoutId = buildPlanPrompt('x', { categories: DEFAULT_CATEGORIES });
  const withoutCategories = buildPlanPrompt('x', { ticketId: '2026-08-07-add-dark-mode' });

  assert.match(withId, /## Record what you learn \(ethos\)/);
  // Planning is the last stage with a human in the room.
  assert.match(withId.replace(/\s+/g, ' '), /last stage that records anything/);
  assert.match(withId, /glafka psyche 2026-08-07-add-dark-mode --security/);
  assert.doesNotMatch(withoutId, /## Record what you learn/);
  assert.doesNotMatch(withoutCategories, /## Record what you learn/);
});
