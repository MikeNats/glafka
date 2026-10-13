import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SUPERPOWERS_INSTALL, superpowersReminder } from '../src/superpowers.js';

test('SUPERPOWERS_INSTALL covers every platform glafka itself supports', () => {
  assert.deepEqual(
    Object.keys(SUPERPOWERS_INSTALL).sort(),
    ['claude', 'cursor', 'gemini', 'github', 'kimi', 'opencode'].sort(),
  );
});

// glafka install is a script, not a chat. It can only run "shell" steps
// for you. Other steps need a chat.
test('only gemini and github are marked shell-executable; the rest require a chat', () => {
  const shell = Object.entries(SUPERPOWERS_INSTALL)
    .filter(([, v]) => v.mechanism === 'shell')
    .map(([k]) => k);
  assert.deepEqual(shell.sort(), ['gemini', 'github']);
});

test('superpowersReminder returns null when nothing was installed', () => {
  assert.equal(superpowersReminder([]), null);
});

test("superpowersReminder returns null for a platform it doesn't know", () => {
  assert.equal(superpowersReminder(['some-future-tool']), null);
});

test('superpowersReminder includes the real command for a claude-only install', () => {
  const text = superpowersReminder(['claude']);
  assert.match(text!, /\/plugin install superpowers@claude-plugins-official/);
  assert.doesNotMatch(text!, /gemini extensions install/);
});

test('superpowersReminder only mentions the platforms it was actually given', () => {
  const text = superpowersReminder(['gemini', 'github']);
  assert.match(text!, /gemini extensions install/);
  assert.match(text!, /copilot plugin marketplace add/);
  assert.doesNotMatch(text!, /\/add-plugin superpowers/); // this line is for cursor only
});
