import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSpecPrompt } from '../../src/commands/genesis/genesis.js';
import { DEFAULT_CATEGORIES } from '../../src/memory/categories.js';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDir } from '../helpers/tempDir.js';

// A project that has one of the instruction files our platforms read.
function repoWith(file: string): string {
  const repoRoot = makeTempDir('spec-prompt');
  fs.writeFileSync(path.join(repoRoot, file), 'conventions\n');
  return repoRoot;
}

test('buildSpecPrompt embeds the raw idea text', () => {
  const prompt = buildSpecPrompt('add a health check endpoint');

  assert.match(prompt, /add a health check endpoint/);
});

test('buildSpecPrompt asks for a spec, clarifying questions, and project memory — but not a plan', () => {
  const prompt = buildSpecPrompt('x', { repoRoot: repoWith('CLAUDE.md') });

  assert.match(prompt, /write the spec/);
  assert.match(prompt, /acceptance criteria/);
  assert.match(prompt, /clarifying questions/);
  assert.match(prompt, /CLAUDE\.md/);
  assert.doesNotMatch(prompt, /## Plan/);
});

// The section is named after what the project has, not after one platform.
test('buildSpecPrompt names the instructions file the project actually has', () => {
  assert.match(buildSpecPrompt('x', { repoRoot: repoWith('GEMINI.md') }), /Read GEMINI\.md first/);
  assert.match(buildSpecPrompt('x', { repoRoot: repoWith('AGENTS.md') }), /Read AGENTS\.md first/);
});

// Telling an agent to read a file that is not there wastes a turn.
test('buildSpecPrompt drops the project-memory section when the project has none', () => {
  const prompt = buildSpecPrompt('x', { repoRoot: makeTempDir('spec-prompt-bare') });

  assert.doesNotMatch(prompt, /## Project memory/);
  assert.doesNotMatch(prompt, /CLAUDE\.md/);
});

// This adds a hard stop, so the agent must wait for answers
// instead of jumping straight to a plan.
test('buildSpecPrompt tells the agent to stop and wait, not just to ask', () => {
  const prompt = buildSpecPrompt('x');

  assert.match(prompt, /STOP HERE/);
  assert.match(prompt, /wait for the requester's answers/);
  // There is no "Spec section" any more. The sections below are what come next.
  assert.match(prompt, /move on to the sections below/);
  assert.doesNotMatch(prompt, /Spec section below/);
});

test('buildSpecPrompt includes persona content when given, omits it when not', () => {
  const withPersona = buildSpecPrompt('x', {
    personaContent: '# Teacher\nAsk one question at a time.\n',
  });
  const withoutPersona = buildSpecPrompt('x');

  assert.match(withPersona, /Ask one question at a time/);
  assert.doesNotMatch(withoutPersona, /Persona/);
});

test('buildSpecPrompt is plain text with no agent-specific tool references', () => {
  const prompt = buildSpecPrompt('x');

  assert.doesNotMatch(prompt, /superpowers/i);
  assert.doesNotMatch(prompt, /\bSkill\b/);
  assert.doesNotMatch(prompt, /Claude Code/i);
});

test('buildSpecPrompt includes the codebase map when odysse has been run, omits it when not', () => {
  const withMap = buildSpecPrompt('x', { architectureIndex: '- src/ — the CLI entrypoints' });
  const withoutMap = buildSpecPrompt('x');

  assert.match(withMap, /## Codebase map/);
  assert.match(withMap, /```\n- src\/ — the CLI entrypoints\n```/);
  assert.doesNotMatch(withoutMap, /## Codebase map/);
});

test('buildSpecPrompt includes the destination when one is written, omits it when not', () => {
  const withDestination = buildSpecPrompt('x', { proorismos: 'Become the default tool for X.' });
  const withoutDestination = buildSpecPrompt('x');

  assert.match(withDestination, /## Destination\nWhere this project is trying to go/);
  assert.match(withDestination, /Become the default tool for X\./);
  assert.doesNotMatch(withoutDestination, /## Destination/);
});

// This field was once dropped by the --draft CLI path. Make sure
// it always shows up.
test('buildSpecPrompt includes project rules when ethos exists, omits it when not', () => {
  const withEthos = buildSpecPrompt('x', {
    ethosContent: '- prefer composition over inheritance',
  });
  const withoutEthos = buildSpecPrompt('x');

  assert.match(withEthos, /## Project rules[\s\S]*- prefer composition over inheritance/);
  assert.doesNotMatch(withoutEthos, /## Project rules/);
});

// Brainstorming is the first point where a person can give feedback.
test('buildSpecPrompt tells the agent to record ethos when a ticket id is given, omits it when not', () => {
  const withId = buildSpecPrompt('x', {
    ticketId: '2026-08-07-add-dark-mode',
    categories: DEFAULT_CATEGORIES,
  });
  const withoutId = buildSpecPrompt('x', { categories: DEFAULT_CATEGORIES });
  const withoutCategories = buildSpecPrompt('x', { ticketId: '2026-08-07-add-dark-mode' });

  assert.match(withId, /## Record what you learn \(ethos\)/);
  assert.match(withId, /glafka psyche 2026-08-07-add-dark-mode --security/);
  assert.doesNotMatch(withoutId, /## Record what you learn/);
  assert.doesNotMatch(withoutCategories, /## Record what you learn/);
});

import { fileURLToPath } from 'node:url';
import { SPEC_TEMPLATE } from '../../src/commands/genesis/specTemplate.js';

const GENESIS_SKILL = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'installKit',
  'skills',
  'genesis.md',
);

test('the spec prompt runs an AC round once the approach is agreed, and carries the template', () => {
  const prompt = buildSpecPrompt('add dark mode');
  // The --draft prompt has no separate design step, so it names what the requester agreed to.
  assert.match(prompt, /## Acceptance criteria — once the requester agrees with the approach/);
  assert.match(prompt, /marked "suggested"/);
  assert.match(prompt, /cannot be checked by running the app/);
  assert.ok(prompt.includes(SPEC_TEMPLATE), 'the prompt must embed the spec template');
});

test('genesis.md carries the same spec template as the prompt', () => {
  const skill = fs.readFileSync(GENESIS_SKILL, 'utf8');
  assert.ok(skill.includes(SPEC_TEMPLATE), 'genesis.md and SPEC_TEMPLATE have drifted apart');
});
