import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHeurekaPrompt } from '../../src/commands/heureka/heureka.js';
import { DEFAULT_CATEGORIES } from '../../src/memory/categories.js';

test('buildHeurekaPrompt embeds the ticket id and the raw idea', () => {
  const prompt = buildHeurekaPrompt({
    ticket: { id: '2026-08-07-add-dark-mode' },
    idea: 'maybe a caching layer?',
  });

  assert.match(prompt, /2026-08-07-add-dark-mode/);
  assert.match(prompt, /## The idea\nmaybe a caching layer\?/);
});

test("buildHeurekaPrompt explicitly says there's no fixed plan to follow", () => {
  const prompt = buildHeurekaPrompt({ ticket: { id: '2026-08-07-add-dark-mode' }, idea: 'x' });

  assert.match(prompt, /NOT a fixed plan/);
  assert.match(prompt, /No fixed plan to follow/);
});

test('buildHeurekaPrompt points back to genesis when an idea turns out to need real structure', () => {
  const prompt = buildHeurekaPrompt({ ticket: { id: '2026-08-07-add-dark-mode' }, idea: 'x' });

  assert.match(prompt, /`genesis`/);
});

test('buildHeurekaPrompt says the next step is review, same as any other ticket', () => {
  const prompt = buildHeurekaPrompt({ ticket: { id: '2026-08-07-add-dark-mode' }, idea: 'x' });

  assert.match(prompt, /`ergon --review`/);
});

test('buildHeurekaPrompt omits project-memory/ethos/map sections entirely when absent', () => {
  const prompt = buildHeurekaPrompt({ ticket: { id: '2026-08-07-add-dark-mode' }, idea: 'x' });

  assert.doesNotMatch(prompt, /## Project memory/);
  assert.doesNotMatch(prompt, /## Project rules/);
  assert.doesNotMatch(prompt, /## Codebase map/);
});

test('buildHeurekaPrompt includes the codebase map, project memory, and project rules when given', () => {
  const prompt = buildHeurekaPrompt({
    ticket: { id: '2026-08-07-add-dark-mode' },
    idea: 'x',
    context: {
      architectureIndex: '- src/commands/ — one file per CLI command',
      projectMemory: 'this project uses uv for dependency management',
      ethosContent: '- prefer composition over inheritance',
    },
  });

  assert.match(prompt, /## Codebase map/);
  assert.match(prompt, /```\n- src\/commands\/ — one file per CLI command\n```/);
  assert.match(prompt, /## Project memory\nthis project uses uv/);
  assert.match(prompt, /## Project rules[\s\S]*- prefer composition over inheritance/);
});

test('buildHeurekaPrompt includes the active persona when given, omits it when not', () => {
  const withPersona = buildHeurekaPrompt({
    ticket: { id: '2026-08-07-add-dark-mode' },
    idea: 'x',
    context: { personaContent: '- lead with what if\n- start from the user' },
  });
  const withoutPersona = buildHeurekaPrompt({
    ticket: { id: '2026-08-07-add-dark-mode' },
    idea: 'x',
  });

  assert.match(
    withPersona,
    /## Persona\nFollow this style while exploring:\n\n- lead with what if/,
  );
  assert.doesNotMatch(withoutPersona, /## Persona/);
});

test('buildHeurekaPrompt includes the destination when one is written, omits it when not', () => {
  const withDestination = buildHeurekaPrompt({
    ticket: { id: '2026-08-07-add-dark-mode' },
    idea: 'x',
    context: { proorismos: 'Become the default tool for X.' },
  });
  const withoutDestination = buildHeurekaPrompt({
    ticket: { id: '2026-08-07-add-dark-mode' },
    idea: 'x',
  });

  assert.match(withDestination, /## Destination\nWhere this project is trying to go/);
  assert.match(withDestination, /Become the default tool for X\./);
  assert.doesNotMatch(withoutDestination, /## Destination/);
});

test('buildHeurekaPrompt states the worktree path explicitly when given, omits it when not', () => {
  const withPath = buildHeurekaPrompt({
    ticket: {
      id: '2026-08-07-add-dark-mode',
      worktree: '/repo/.worktrees/2026-08-07-add-dark-mode',
    },
    idea: 'x',
  });
  const withoutPath = buildHeurekaPrompt({
    ticket: { id: '2026-08-07-add-dark-mode' },
    idea: 'x',
  });

  assert.match(withPath, /Your worktree is at `\/repo\/\.worktrees\/2026-08-07-add-dark-mode`/);
  assert.doesNotMatch(withoutPath, /Your worktree is at/);
});

test('buildHeurekaPrompt is plain text with no agent-specific tool references', () => {
  const prompt = buildHeurekaPrompt({ ticket: { id: '2026-08-07-add-dark-mode' }, idea: 'x' });

  assert.doesNotMatch(prompt, /superpowers/i);
  assert.doesNotMatch(prompt, /\bSkill\b/);
  assert.doesNotMatch(prompt, /Claude/i);
});

test('buildHeurekaPrompt tells the explorer to record what it learned', () => {
  const prompt = buildHeurekaPrompt({
    ticket: { id: '2026-08-07-fix-the-login-bypass' },
    idea: 'maybe a caching layer?',
    context: { categories: DEFAULT_CATEGORIES },
  });

  assert.match(prompt, /## Record what you learn \(ethos\)/);
  assert.match(prompt, /glafka psyche 2026-08-07-fix-the-login-bypass --architecture/);
  assert.match(prompt, /do not wait until exploring is finished/);
  assert.doesNotMatch(prompt, /last stage that records anything/);
});
