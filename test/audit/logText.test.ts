import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logText } from '../../src/audit/logText.js';

test('a plain log is unchanged', () => {
  const log = 'reading the plan\nrunning the checks\nVERDICT: clean';
  assert.equal(logText(log), log);
});

// The verdict line and the blocking report both live inside these objects.
// Read raw, the reviewer's answer is invisible.
test('the words inside a stream-json log come back out', () => {
  const log = [
    '{"type":"assistant","message":{"content":[{"type":"text","text":"looking at the diff"}]}}',
    '{"type":"result","result":"VERDICT: clean","usage":{"input_tokens":9,"output_tokens":2}}',
  ].join('\n');

  assert.equal(logText(log), 'looking at the diff\nVERDICT: clean');
});

// A tool call would otherwise count as a line of content and push the verdict
// out of the small window the scan looks back over.
test('events carrying no words are dropped', () => {
  const log = [
    '{"type":"system","subtype":"init"}',
    '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read"}]}}',
    '{"type":"result","result":"VERDICT: blocking — no tests"}',
  ].join('\n');

  assert.equal(logText(log), 'VERDICT: blocking — no tests');
});

// The tail starts mid-file, so its first line is usually cut in half.
test('a half line is kept as it is', () => {
  const log = '"text":"cut in half"}}\n{"type":"result","result":"done"}';
  assert.equal(logText(log), '"text":"cut in half"}}\ndone');
});
