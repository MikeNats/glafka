import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUsage, agentName } from '../../src/audit/parseUsage.js';

test('claude --output-format json usage is read', () => {
  const out = JSON.stringify({
    type: 'result',
    usage: { input_tokens: 48000, output_tokens: 6200 },
  });

  assert.deepEqual(parseUsage(out), {
    in: 48000,
    out: 6200,
    cacheRead: 0,
    cacheWrite: 0,
    source: 'claude-json',
  });
});

// Agents print prose around their JSON, and stream-json prints one object
// per line. The usage block is at the end either way.
test('the usage block is found even with prose or many lines around it', () => {
  const line = JSON.stringify({ usage: { input_tokens: 10, output_tokens: 2 } });
  const out = `starting up\n${JSON.stringify({ type: 'assistant' })}\n${line}\nbye\n`;

  assert.deepEqual(parseUsage(out), {
    in: 10,
    out: 2,
    cacheRead: 0,
    cacheWrite: 0,
    source: 'claude-json',
  });
});

// null is "we did not measure", and must never be mistaken for zero.
test('output we cannot read yields null, never zeroes', () => {
  assert.equal(parseUsage(null), null);
  assert.equal(parseUsage(''), null);
  assert.equal(parseUsage('I had a look and it all seems fine!'), null);
  assert.equal(parseUsage('{"usage":{"input_tokens":"lots"}}'), null);
  assert.equal(parseUsage('[1,2,3]'), null);
});

// The configured command can hold flags, paths and occasionally a credential.
// Only the program's own name belongs in a file that outlives the ticket.
test('only the program name is kept from the command', () => {
  assert.equal(agentName('claude -p --permission-mode acceptEdits'), 'claude');
  assert.equal(agentName('/usr/local/bin/claude --api-key sk-secret'), 'claude');
  assert.equal(agentName('  opencode   run  '), 'opencode');
  assert.equal(agentName(''), 'unknown');
});

// stream-json prints one object per line and EVERY assistant message carries
// its own incremental usage. Only the result line totals the run.
test('the result line wins over the per-message usage before it', () => {
  const out = [
    '{"type":"assistant","usage":{"input_tokens":40000,"output_tokens":900}}',
    '{"type":"assistant","usage":{"input_tokens":41000,"output_tokens":1500}}',
    '{"type":"result","usage":{"input_tokens":81000,"output_tokens":2400}}',
  ].join('\n');

  assert.deepEqual(parseUsage(out), {
    in: 81000,
    out: 2400,
    cacheRead: 0,
    cacheWrite: 0,
    source: 'claude-json',
  });
});

// An agent that died before its result line leaves only a part of the story.
// Recording that as the total under-reports the run, so it says it is partial.
test('usage with no result line is reported as partial, not as a total', () => {
  const out = '{"type":"assistant","usage":{"input_tokens":41000,"output_tokens":1500}}';

  assert.deepEqual(parseUsage(out), {
    in: 41000,
    out: 1500,
    cacheRead: 0,
    cacheWrite: 0,
    source: 'claude-json-partial',
  });
});

// A real stream-json result line. Most of the input sits in the two cache
// fields, so reading only input_tokens under-counted it by a factor of 2000.
const REAL_RESULT_LINE =
  '{"type":"result","subtype":"success","is_error":false,"duration_ms":2300,"num_turns":1,' +
  '"result":"ok","session_id":"0b6c7a8e-1111-2222-3333-444455556666","total_cost_usd":0.0123,' +
  '"usage":{"input_tokens":12,"cache_creation_input_tokens":4567,"cache_read_input_tokens":20480,' +
  '"output_tokens":310}}';

test('cache reads and cache writes are read off a real result line', () => {
  assert.deepEqual(parseUsage(REAL_RESULT_LINE), {
    in: 12,
    out: 310,
    cacheRead: 20480,
    cacheWrite: 4567,
    source: 'claude-json',
  });
});

test('a cache field that is not a number counts as 0, not as a broken line', () => {
  const out =
    '{"type":"result","usage":{"input_tokens":5,"output_tokens":1,"cache_read_input_tokens":"x"}}';

  assert.deepEqual(parseUsage(out), {
    in: 5,
    out: 1,
    cacheRead: 0,
    cacheWrite: 0,
    source: 'claude-json',
  });
});
