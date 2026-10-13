import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { checkAgentCmd, writeAgentCmd } from '../../src/commands/install/checkAgentCmd.js';
import { makeTempDir } from '../helpers/tempDir.js';

// A PATH holding one fake executable, so the probe's "is it installed" step can be steered
// without depending on what happens to be on the machine running the tests.
function pathWith(...binaries: string[]): NodeJS.ProcessEnv {
  const dir = makeTempDir('fake-bin');
  for (const name of binaries) {
    fs.writeFileSync(path.join(dir, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  return { PATH: dir };
}

test('a command that answers is believed', () => {
  const result = checkAgentCmd('claude', {
    env: pathWith('claude'),
    run: () => 'GLAFKAOK\n',
  });

  assert.match(result.cmd!, /^claude -p /);
  assert.equal(result.why, null);
});

// The exact bug this probe exists for. A bare `claude -p` reads its prompt, is refused
// write access, and exits 0 — which glafka then records as a finished run.
test('a command that exits 0 without answering is not believed', () => {
  const result = checkAgentCmd('claude', {
    env: pathWith('claude'),
    run: () => '',
  });

  assert.equal(result.cmd, null);
  assert.match(result.why!, /ran but did not answer/);
});

test('a command that throws is an answer, not a crash', () => {
  const result = checkAgentCmd('claude', {
    env: pathWith('claude'),
    run: () => {
      throw new Error('spawnSync /bin/sh ETIMEDOUT');
    },
  });

  assert.equal(result.cmd, null);
  assert.match(result.why!, /failed to run/);
});

// Much the commonest answer, and the one that must not cost an LLM call.
test('a CLI that is not installed is reported without running anything', () => {
  let ran = false;
  const result = checkAgentCmd('gemini', {
    env: pathWith('claude'),
    run: () => {
      ran = true;
      return 'GLAFKAOK';
    },
  });

  assert.equal(ran, false, 'nothing may be spawned when the binary is not there');
  assert.equal(result.cmd, null);
  assert.match(result.why!, /not installed/);
});

test('every platform glafka installs has a candidate command', () => {
  for (const platform of ['claude', 'cursor', 'gemini', 'opencode', 'kimi', 'github']) {
    const result = checkAgentCmd(platform, { env: { PATH: '' } });
    assert.doesNotMatch(
      result.why!,
      /no reviewer command is known/,
      `${platform} has no candidate`,
    );
  }
});

test('an unknown platform says so rather than guessing', () => {
  assert.match(checkAgentCmd('emacs').why!, /no reviewer command is known/);
});

// --------------------------------------------------------------------------- Writing it down.

test('the reviewer command is written into a fresh .glafka.json', () => {
  const repoRoot = makeTempDir('cfg-fresh');

  assert.deepEqual(writeAgentCmd(repoRoot, 'reviewer', 'claude -p'), {
    written: true,
    reason: null,
  });
  const config = JSON.parse(fs.readFileSync(path.join(repoRoot, '.glafka.json'), 'utf8'));
  assert.equal(config.agents.reviewer, 'claude -p');
});

test('an existing config keeps every key it already had', () => {
  const repoRoot = makeTempDir('cfg-existing');
  fs.writeFileSync(
    path.join(repoRoot, '.glafka.json'),
    JSON.stringify({ checksCmd: 'npm test', agents: { coder: 'my-coder' } }),
  );

  writeAgentCmd(repoRoot, 'reviewer', 'claude -p');

  const config = JSON.parse(fs.readFileSync(path.join(repoRoot, '.glafka.json'), 'utf8'));
  assert.equal(config.checksCmd, 'npm test');
  assert.equal(config.agents.coder, 'my-coder');
  assert.equal(config.agents.reviewer, 'claude -p');
});

// A person who configured a reviewer meant it. A probe result must not overrule them.
test('a reviewer that is already configured is never replaced', () => {
  const repoRoot = makeTempDir('cfg-taken');
  fs.writeFileSync(
    path.join(repoRoot, '.glafka.json'),
    JSON.stringify({ agents: { reviewer: 'mine' } }),
  );

  const result = writeAgentCmd(repoRoot, 'reviewer', 'claude -p');

  assert.equal(result.written, false);
  assert.match(result.reason!, /already configured/);
  const config = JSON.parse(fs.readFileSync(path.join(repoRoot, '.glafka.json'), 'utf8'));
  assert.equal(config.agents.reviewer, 'mine');
});

// Rewriting a file we cannot read would throw away whatever is in it.
test('a broken .glafka.json is left exactly as it is', () => {
  const repoRoot = makeTempDir('cfg-broken');
  const filePath = path.join(repoRoot, '.glafka.json');
  fs.writeFileSync(filePath, '{ not json');

  const result = writeAgentCmd(repoRoot, 'reviewer', 'claude -p');

  assert.equal(result.written, false);
  assert.match(result.reason!, /not valid JSON/);
  assert.equal(fs.readFileSync(filePath, 'utf8'), '{ not json');
});

// --------------------------------------------------------------------------- The QA tester.

test('every platform glafka installs has a verifier candidate', () => {
  for (const platform of ['claude', 'cursor', 'gemini', 'opencode', 'kimi', 'github']) {
    const result = checkAgentCmd(platform, { env: { PATH: '' }, role: 'verifier' });
    assert.doesNotMatch(result.why!, /no verifier command is known/, `${platform} has none`);
  }
});

// It must run curl and the project's own CLI, and it should not edit what it is testing.
test('the claude verifier may run any shell command, and may not edit files', () => {
  const result = checkAgentCmd('claude', {
    env: pathWith('claude'),
    run: () => 'GLAFKAOK',
    role: 'verifier',
  });
  const cmd = result.cmd!;
  assert.match(cmd, /--allowedTools '[^']*\bBash\b(?!\()/);
  assert.match(cmd, /--disallowedTools '[^']*\bEdit\b/);
  assert.match(cmd, /--disallowedTools '[^']*\bWrite\b/);
  assert.doesNotMatch(cmd, /acceptEdits/);
});
