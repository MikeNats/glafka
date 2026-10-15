import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeGitRepo } from '../helpers/gitFixture.js';
import { makeTempDir } from '../helpers/tempDir.js';
import { odysse } from '../../src/commands/odysse/odysse.js';
import { runOdysse } from '../../installKit/bin/commands/odysse.js';
import { loadConfig } from '../../src/config.js';
import { architectureStampPath } from '../../src/memory/docsStore.js';

// --- odysse() unit tests ---

test('odysse returns cbmIndexed: true when CBM is available', () => {
  const repoRoot = makeGitRepo();
  const calls: string[] = [];

  const result = odysse({
    repoRoot,
    cbm: {
      available: () => true,
      indexRepository: (root: string) => {
        calls.push(root);
      },
    },
  });

  assert.equal(result.cbmIndexed, true);
  assert.equal(result.prompt, null);
  assert.deepEqual(calls, [repoRoot]);
});

test('odysse returns cbmIndexed: false and a prompt when CBM is absent', () => {
  const repoRoot = makeGitRepo();

  const result = odysse({
    repoRoot,
    cbm: { available: () => false, indexRepository: () => {} },
  });

  assert.equal(result.cbmIndexed, false);
  assert.ok(typeof result.prompt === 'string');
  assert.ok(result.prompt.length > 0);
});

test('odysse defaults to real cbm functions when no cbm option is given', () => {
  const repoRoot = makeGitRepo();

  // CBM binary is not on PATH in test, so it falls through to the prompt path.
  const result = odysse({ repoRoot });

  assert.equal(result.cbmIndexed, false);
  assert.ok(typeof result.prompt === 'string');
});

// --- runOdysse / runFullScan integration tests ---

function captureStderr(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const real = console.error;
  console.error = (...a: unknown[]) => lines.push(a.join(' '));
  return fn().then(
    () => {
      console.error = real;
      return lines.join('\n');
    },
    (err) => {
      console.error = real;
      throw err;
    },
  );
}

// AC-1 / AC-4: CBM path skips deliverPrompt and reports CBM.
test('CBM path: reports indexed by codebase-memory-mcp', async () => {
  const repoRoot = makeGitRepo();

  const output = await captureStderr(() =>
    runOdysse({
      args: [],
      repoRoot,
      stateDir: makeTempDir('state'),
      config: loadConfig(repoRoot),
      cbm: { available: () => true, indexRepository: () => {} },
    }),
  );

  assert.match(output, /indexed by codebase-memory-mcp/);
});

// AC-2: scan.json is written with the current HEAD commit.
test('CBM path: scan.json is written', async () => {
  const repoRoot = makeGitRepo();

  await runOdysse({
    args: [],
    repoRoot,
    stateDir: makeTempDir('state'),
    config: loadConfig(repoRoot),
    cbm: { available: () => true, indexRepository: () => {} },
  });

  const stamp = JSON.parse(fs.readFileSync(architectureStampPath(repoRoot), 'utf8'));
  assert.ok(typeof stamp.commit === 'string');
  assert.ok(stamp.commit.length > 0);
});

// AC-3: non-CBM path falls through to the prompt.
test('non-CBM path: report says doc(s) or prompt is printed', async () => {
  const repoRoot = makeGitRepo();

  const output = await captureStderr(() =>
    runOdysse({
      args: [],
      repoRoot,
      stateDir: makeTempDir('state'),
      config: loadConfig(repoRoot),
      cbm: { available: () => false, indexRepository: () => {} },
    }),
  );

  // No agent ran (no GLAFKA_AGENT_CMD in tests), so the prompt-paste message appears.
  assert.match(output, /Once the scan above is done/);
  assert.doesNotMatch(output, /indexed by codebase-memory-mcp/);
});
