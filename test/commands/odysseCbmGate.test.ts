import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeGitRepo } from '../helpers/gitFixture.js';
import { odysse } from '../../src/commands/odysse/odysse.js';

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
