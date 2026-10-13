import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withUsageFlags } from '../../src/audit/usageFlags.js';

// Without this the token fields in every audit row are null: an agent only
// reports what it spent when it is asked for machine output.
test('a background claude run is asked for its token usage', () => {
  assert.equal(
    withUsageFlags('claude -p --permission-mode acceptEdits'),
    'claude -p --permission-mode acceptEdits --output-format stream-json --verbose',
  );
});

// stream-json, not json: json prints nothing until the end, and a log that
// stops growing reads as a stalled run.
test('the streaming format is the one asked for', () => {
  assert.ok(withUsageFlags('claude -p').includes('stream-json'));
});

test('an agent that is not claude is left alone', () => {
  const cmd = 'opencode run --yolo';
  assert.equal(withUsageFlags(cmd), cmd);
});

// The flags go on the end, which is the wrong command when there is more
// than one.
test('a command with a pipe or a chain is left alone', () => {
  assert.equal(withUsageFlags('claude -p | tee out.txt'), 'claude -p | tee out.txt');
  assert.equal(withUsageFlags('claude -p && echo done'), 'claude -p && echo done');
});

// A real reviewer command. The brackets and colons are inside quotes, so the
// shell never sees them — reading them as a second command measured nothing.
test('punctuation inside quotes is not a second command', () => {
  const cmd =
    "claude -p --permission-mode acceptEdits --allowedTools 'Read,Glob,Bash(git log:*),Bash(glafka:*)'";
  assert.equal(withUsageFlags(cmd), `${cmd} --output-format stream-json --verbose`);
});

test('an output format you chose yourself wins', () => {
  const cmd = 'claude -p --output-format json';
  assert.equal(withUsageFlags(cmd), cmd);
});

// stream-json is a print-mode format. Adding it to an interactive command
// would make the command fail instead of measuring it.
test('a command without print mode is left alone', () => {
  assert.equal(
    withUsageFlags('claude --permission-mode acceptEdits'),
    'claude --permission-mode acceptEdits',
  );
});
