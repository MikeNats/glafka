import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildVerifyPrompt } from '../../src/commands/epalitheusis/prompts.js';

const BASE = {
  ticketId: '2026-10-08-add-export',
  criteria: [{ id: 'AC-1', text: 'empty report → GET /export → 200' }],
  worktree: '/tmp/wt',
  ports: 'PORT=4100',
};

test('the tester prompt opens with the QA role and carries the AC, worktree and ports', () => {
  const prompt = buildVerifyPrompt({ ...BASE, token: 'abc123' });
  assert.match(
    prompt,
    /^You are a QA tester\. You test ticket 2026-10-08-add-export from OUTSIDE, like a user\./,
  );
  assert.match(prompt, /- AC-1: empty report → GET \/export → 200/);
  assert.match(prompt, /\/tmp\/wt/);
  assert.match(prompt, /PORT=4100/);
  assert.match(prompt, /Do not edit, create, or commit files/);
  assert.match(prompt, /--token abc123/);
});

test('the printed brief has no token at all', () => {
  const prompt = buildVerifyPrompt(BASE);
  assert.doesNotMatch(prompt, /--token/);
});

test('the tester is told to keep scratch files out of the worktree', () => {
  const prompt = buildVerifyPrompt(BASE);
  assert.match(prompt, /outside the worktree/);
  assert.match(prompt, /cookie jars, downloads, screenshots, logs/);
  assert.match(prompt, /curl -c "\$\{TMPDIR:-\/tmp\}\/cookies\.txt"/);
});

// I2: every guardrails level refuses `vima` to an agent, so the tester is never told to run it.
// glafka makes sure the app is up before it starts the tester.
test('the tester is not told to restart the app; a dead app is a cannot', () => {
  const prompt = buildVerifyPrompt({ ...BASE, token: 'abc123' });
  assert.doesNotMatch(prompt, /vima/);
  assert.match(prompt, /If the app does not answer, record `cannot` with what you saw\./);
});

// M12: a value that starts with "--" reads as an unknown flag, and the result is refused.
test('the tester is told never to start --evidence with "--"', () => {
  assert.match(buildVerifyPrompt(BASE), /Never start --evidence with '--'\./);
});
