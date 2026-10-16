import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { withoutAgentCmd } from './helpers/noAgentEnv.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// With GLAFKA_AGENT_CMD set, the "no agent configured" tests find an agent and start a
// real, paid one. The runners drop it from the env they hand the test process.
test('the test runners drop GLAFKA_AGENT_CMD from the env they pass on', () => {
  const script =
    "import { testEnv } from './scripts/lib/testEnv.mjs';" +
    "console.log(JSON.stringify(testEnv({ GLAFKA_AGENT_CMD: 'claude -p', PATH: '/bin' })));";
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.deepEqual(JSON.parse(out), { PATH: '/bin', GLAFKA_CODE_GRAPH: 'off' });
  const runners = [
    'scripts/run-all-tests.mjs',
    'scripts/select-fast-tests.mjs',
    'scripts/profile-tests.mjs',
  ];
  for (const runner of runners) {
    assert.match(fs.readFileSync(path.join(ROOT, runner), 'utf8'), /env: testEnv\(\)/, runner);
  }
});

// M15: a test file run directly, not through a runner, still must not find an agent.
test('withoutAgentCmd clears GLAFKA_AGENT_CMD, and its restore puts it back', () => {
  const previous = process.env.GLAFKA_AGENT_CMD;
  process.env.GLAFKA_AGENT_CMD = 'claude -p';
  try {
    const restore = withoutAgentCmd();
    assert.equal(process.env.GLAFKA_AGENT_CMD, undefined);
    restore();
    assert.equal(process.env.GLAFKA_AGENT_CMD, 'claude -p');
  } finally {
    if (previous === undefined) delete process.env.GLAFKA_AGENT_CMD;
    else process.env.GLAFKA_AGENT_CMD = previous;
  }
});
