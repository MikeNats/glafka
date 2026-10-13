import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeGitRepo } from '../helpers/gitFixture.js';
import { readEthosDocs, parseScope, pathsNamedIn } from '../../src/memory/ethos.js';
import { ethosPath, writeDoc } from '../../src/memory/docsStore.js';

function withRules(body: string): string {
  const repoRoot = makeGitRepo();
  writeDoc(
    ethosPath(repoRoot, 'ETHOS_CODE'),
    `# ETHOS_CODE\n\n## Authored\n\n${body}\n\n## Proposed\n\n## Learned\n`,
  );
  return repoRoot;
}

const RULES = [
  '- [scope: **/migrations/**] every migration must be reversible',
  '- [scope: src/api/**] routes validate their input at the edge',
  '- always wrap errors at the boundary',
].join('\n');

test('parseScope splits the marker off, and leaves an unscoped rule alone', () => {
  assert.deepEqual(parseScope('[scope: src/**] do the thing'), {
    scope: 'src/**',
    text: 'do the thing',
  });
  assert.deepEqual(parseScope('do the thing'), { scope: null, text: 'do the thing' });
});

// The whole point of scoping: a prompt about one area does not carry the
// rules for every other area.
test('only the rules whose scope matches the paths are sent', () => {
  const docs = readEthosDocs(withRules(RULES), ['db/migrations/001_add_users.sql']);

  assert.match(docs!, /every migration must be reversible/);
  assert.match(docs!, /always wrap errors at the boundary/);
  assert.equal(docs!.includes('routes validate their input'), false);
});

test('an unscoped rule is always sent, whatever the paths are', () => {
  const repoRoot = withRules(RULES);
  assert.match(readEthosDocs(repoRoot, ['nothing/relevant.txt'])!, /wrap errors at the boundary/);
});

// THE ONE THAT MATTERS. Filtering against "no paths" would drop every scoped rule and look like a
// tidier prompt while withholding what the agent needed. Not knowing is not the same as knowing there is nothing.
test('when the paths are unknown, every rule is sent', () => {
  const docs = readEthosDocs(withRules(RULES), null);

  assert.match(docs!, /every migration must be reversible/);
  assert.match(docs!, /routes validate their input/);
  assert.match(docs!, /always wrap errors at the boundary/);
});

// The agent is being told a rule, not how the rule was chosen.
test('the scope marker never reaches the prompt', () => {
  const docs = readEthosDocs(withRules(RULES), ['db/migrations/001.sql']);
  assert.equal(docs!.includes('[scope:'), false);
});

test('a file with no rules left after filtering is dropped, not sent empty', () => {
  const repoRoot = withRules('- [scope: src/api/**] routes validate their input');
  assert.equal(readEthosDocs(repoRoot, ['README.md']), null);
});

// --------------------------------------------------------------------------- Gap 5: the coder has no
// diff, so its paths come from the plan. ---------------------------------------------------------------------------

test('paths are read out of plan prose, including the folders above them', () => {
  const paths = pathsNamedIn(
    '1. Add a migration in db/migrations/001.sql\n2. Update `src/api/x.ts`',
  );

  assert.ok(paths!.includes('db/migrations/001.sql'));
  // So a rule scoped to `db/migrations/**` matches a plan that names one file.
  assert.ok(paths!.includes('db/migrations/'));
  assert.ok(paths!.includes('src/api/x.ts'));
});

test('a plan that names a migration gets the migration rule', () => {
  const repoRoot = withRules(RULES);
  const docs = readEthosDocs(repoRoot, pathsNamedIn('1. Add db/migrations/001_add_users.sql'));

  assert.match(docs!, /every migration must be reversible/);
  assert.equal(docs!.includes('routes validate their input'), false);
});

// Finding nothing must mean "unknown", never "no files".
test('a plan that names no file sends every rule rather than none', () => {
  assert.equal(pathsNamedIn('Rewrite the thing so it is faster.'), null);

  const docs = readEthosDocs(withRules(RULES), pathsNamedIn('Rewrite the thing so it is faster.'));
  assert.match(docs!, /every migration must be reversible/);
  assert.match(docs!, /routes validate their input/);
});

test('prose with a slash in it is not mistaken for a path', () => {
  assert.equal(pathsNamedIn('read the docs and/or ask someone'), null);
});

test('empty or missing text is unknown, not empty', () => {
  assert.equal(pathsNamedIn(''), null);
  assert.equal(pathsNamedIn(null), null);
});
