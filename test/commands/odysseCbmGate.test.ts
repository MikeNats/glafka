import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeGitRepo } from '../helpers/gitFixture.js';
import { makeTempDir } from '../helpers/tempDir.js';
import { odysse } from '../../src/commands/odysse/odysse.js';
import { runOdysse } from '../../installKit/bin/commands/odysse.js';
import { loadConfig } from '../../src/config.js';
import {
  architectureStampPath,
  workspaceProposalPath,
  writeDoc,
} from '../../src/memory/docsStore.js';
import { proposeEthos } from '../../src/memory/ethos.js';

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

  const result = odysse({ repoRoot });

  assert.equal(result.cbmIndexed, false);
  assert.ok(typeof result.prompt === 'string');
});

// --- helpers ---

async function captureAll(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const realLog = console.log;
  const realErr = console.error;
  console.log = (...a: unknown[]) => lines.push(a.join(' '));
  console.error = (...a: unknown[]) => lines.push(a.join(' '));
  try {
    await fn();
  } finally {
    console.log = realLog;
    console.error = realErr;
  }
  return lines.join('\n');
}

const cbmPresent = { available: () => true, indexRepository: () => {} };

// --- runFullScan integration tests ---

test('CBM path: reports indexed by codebase-memory-mcp', async () => {
  const repoRoot = makeGitRepo();

  const output = await captureAll(() =>
    runOdysse({
      args: [],
      repoRoot,
      stateDir: makeTempDir('state'),
      config: loadConfig(repoRoot),
      cbm: cbmPresent,
    }),
  );

  assert.match(output, /indexed by codebase-memory-mcp/);
});

test('CBM path: scan.json is written', async () => {
  const repoRoot = makeGitRepo();

  await runOdysse({
    args: [],
    repoRoot,
    stateDir: makeTempDir('state'),
    config: loadConfig(repoRoot),
    cbm: cbmPresent,
  });

  const stamp = JSON.parse(fs.readFileSync(architectureStampPath(repoRoot), 'utf8'));
  assert.ok(typeof stamp.commit === 'string');
  assert.ok(stamp.commit.length > 0);
});

test('non-CBM path: prompt is printed, not CBM report', async () => {
  const repoRoot = makeGitRepo();

  const output = await captureAll(() =>
    runOdysse({
      args: [],
      repoRoot,
      stateDir: makeTempDir('state'),
      config: loadConfig(repoRoot),
      cbm: { available: () => false, indexRepository: () => {} },
    }),
  );

  assert.match(output, /Once the scan above is done/);
  assert.doesNotMatch(output, /indexed by codebase-memory-mcp/);
});

// --- AC-5/6/7: flag paths are unaffected by CBM presence ---

test('--checks still works with CBM present', async () => {
  const repoRoot = makeGitRepo();

  const output = await captureAll(() =>
    runOdysse({
      args: ['--checks'],
      repoRoot,
      stateDir: makeTempDir('state'),
      config: loadConfig(repoRoot),
      cbm: cbmPresent,
    }),
  );

  // The checks probe prompt is printed (no agent in tests).
  assert.doesNotMatch(output, /indexed by codebase-memory-mcp/);
});

test('--keep still works with CBM present', async () => {
  const repoRoot = makeGitRepo();
  proposeEthos(repoRoot, { target: 'ETHOS_CODE', text: 'a rule' });

  const output = await captureAll(() =>
    runOdysse({
      args: ['--keep', 'all'],
      repoRoot,
      stateDir: makeTempDir('state'),
      config: loadConfig(repoRoot),
      cbm: cbmPresent,
    }),
  );

  assert.match(output, /observation\(s\) kept/);
  assert.doesNotMatch(output, /indexed by codebase-memory-mcp/);
});

test('--workspace-keep still works with CBM present', async () => {
  const repoRoot = makeGitRepo();
  writeDoc(workspaceProposalPath(repoRoot), JSON.stringify({ baseRef: 'main' }));

  const output = await captureAll(() =>
    runOdysse({
      args: ['--workspace-keep', 'all'],
      repoRoot,
      stateDir: makeTempDir('state'),
      config: loadConfig(repoRoot),
      cbm: cbmPresent,
    }),
  );

  assert.match(output, /workspace setting\(s\) written/);
  assert.doesNotMatch(output, /indexed by codebase-memory-mcp/);
});
