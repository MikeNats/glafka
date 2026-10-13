import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDir } from '../helpers/tempDir.js';
import {
  loadCategories,
  categoriesPath,
  DEFAULT_CATEGORIES,
  targetOf,
  flagOf,
  flagsOf,
  categoryByTarget,
} from '../../src/memory/categories.js';
import { writeDoc } from '../../src/memory/docsStore.js';

function tempRepoRoot() {
  return makeTempDir('cats');
}

function writeCategories(repoRoot: string, value: unknown) {
  writeDoc(categoriesPath(repoRoot), typeof value === 'string' ? value : JSON.stringify(value));
}

// A new project should work with no config file needed.
test('no categories file falls back to the shipped defaults', () => {
  assert.deepEqual(loadCategories(tempRepoRoot()), DEFAULT_CATEGORIES);
});

test('a categories file REPLACES the defaults rather than adding to them', () => {
  const repoRoot = tempRepoRoot();
  writeCategories(repoRoot, [{ name: 'DOMAIN', hint: 'our billing rules' }]);

  const categories = loadCategories(repoRoot);

  assert.deepEqual(
    categories.map((c) => c.name),
    ['DOMAIN'],
  );
  assert.equal(categories.length, 1, "defaults leaked in alongside the project's own list");
});

test('a name becomes its target id, its filename, and its CLI flag', () => {
  const category = { name: 'DATA_MODEL', hint: 'how rows relate' };

  assert.equal(targetOf(category), 'ETHOS_DATA_MODEL');
  assert.equal(flagOf(category), '--data_model');
  assert.deepEqual(flagsOf([category]), { '--data_model': 'ETHOS_DATA_MODEL' });
});

test('categoryByTarget finds the category a target came from, null when unknown', () => {
  const categories = [{ name: 'DOMAIN', hint: 'billing' }];

  assert.equal(categoryByTarget(categories, 'ETHOS_DOMAIN')!.hint, 'billing');
  assert.equal(categoryByTarget(categories, 'ETHOS_GONE'), null);
});

// Each name becomes a filename and a flag. A bad name must fail
// right away, and say which file is wrong.
test('a name that could not be a filename or a flag is rejected', () => {
  for (const bad of ['lowercase', 'Has Space', 'with-dash', '9LEADING', '']) {
    const repoRoot = tempRepoRoot();
    writeCategories(repoRoot, [{ name: bad, hint: 'x' }]);
    assert.throws(
      () => loadCategories(repoRoot),
      /"name" must be UPPERCASE/,
      `accepted ${JSON.stringify(bad)}`,
    );
  }
});

// A category needs a hint. Without one, an agent can't tell
// what belongs in it.
test('a category with a missing or blank hint is rejected', () => {
  for (const bad of [undefined, '', '   ']) {
    const repoRoot = tempRepoRoot();
    writeCategories(repoRoot, [{ name: 'DOMAIN', hint: bad }]);
    assert.throws(() => loadCategories(repoRoot), /needs a non-empty "hint"/);
  }
});

test('a duplicate name is rejected — two categories would fight over one file', () => {
  const repoRoot = tempRepoRoot();
  writeCategories(repoRoot, [
    { name: 'DOMAIN', hint: 'billing' },
    { name: 'DOMAIN', hint: 'shipping' },
  ]);

  assert.throws(() => loadCategories(repoRoot), /listed twice/);
});

test('an empty array is rejected, and says how to get the defaults back', () => {
  const repoRoot = tempRepoRoot();
  writeCategories(repoRoot, []);

  assert.throws(() => loadCategories(repoRoot), /delete the file to fall back/);
});

test('a non-array and a non-object entry are both rejected', () => {
  const objRoot = tempRepoRoot();
  writeCategories(objRoot, { CODE: 'naming' });
  assert.throws(() => loadCategories(objRoot), /must be a JSON array/);

  const strRoot = tempRepoRoot();
  writeCategories(strRoot, ['CODE']);
  assert.throws(() => loadCategories(strRoot), /every entry must be an object/);
});

test('malformed JSON names the file it failed to parse', () => {
  const repoRoot = tempRepoRoot();
  writeCategories(repoRoot, '{ not json');

  assert.throws(() => loadCategories(repoRoot), /categories\.json: not valid JSON/);
});

test('hints are trimmed, and the loaded set is frozen against accidental mutation', () => {
  const repoRoot = tempRepoRoot();
  writeCategories(repoRoot, [{ name: 'DOMAIN', hint: '  billing rules  ' }]);

  const categories = loadCategories(repoRoot);

  assert.equal(categories[0].hint, 'billing rules');
  assert.throws(() => {
    categories[0].hint = 'hijacked';
  }, TypeError);
});

test("the shipped defaults are all valid by the same rules a project's file faces", () => {
  const repoRoot = tempRepoRoot();
  writeCategories(repoRoot, DEFAULT_CATEGORIES);

  assert.deepEqual(loadCategories(repoRoot), DEFAULT_CATEGORIES);
});
