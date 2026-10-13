import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDir } from '../helpers/tempDir.js';
import {
  promoteEthosCandidates,
  readEthosDocs,
  AUTHORED_HEADING,
  LEARNED_HEADING,
  PROPOSED_HEADING,
  DROPPED_HEADING,
  readProposals,
  decideProposals,
} from '../../src/memory/ethos.js';
import { ethosPath, readDoc, writeDoc } from '../../src/memory/docsStore.js';
import { DEFAULT_CATEGORIES, targetOf } from '../../src/memory/categories.js';

// This copies the old shape of the constant.
// The real values now come from categories.json.
const T = Object.fromEntries(DEFAULT_CATEGORIES.map((c) => [c.name, targetOf(c)]));

function tempRepoRoot() {
  return makeTempDir('ethos');
}

test('promoteEthosCandidates creates one file per target, grouped correctly', () => {
  const repoRoot = tempRepoRoot();

  promoteEthosCandidates(repoRoot, [
    { target: 'ETHOS_CODE', text: 'prefer composition over inheritance' },
    { target: 'ETHOS_DESIGN', text: 'no centered text in artifacts' },
    { target: 'ETHOS_CODE', text: 'no unused abstractions' },
    { target: 'ETHOS_ARCHITECTURE', text: 'the api layer never imports from workers' },
  ]);

  const code = readDoc(ethosPath(repoRoot, 'ETHOS_CODE'));
  const design = readDoc(ethosPath(repoRoot, 'ETHOS_DESIGN'));
  const architecture = readDoc(ethosPath(repoRoot, 'ETHOS_ARCHITECTURE'));

  assert.match(code, /prefer composition over inheritance/);
  assert.match(code, /no unused abstractions/);
  assert.doesNotMatch(code, /centered text/);
  assert.doesNotMatch(code, /never imports/);

  assert.match(design, /no centered text in artifacts/);
  assert.doesNotMatch(design, /composition/);
  assert.doesNotMatch(design, /never imports/);

  assert.match(architecture, /the api layer never imports from workers/);
  assert.doesNotMatch(architecture, /composition/);
  assert.doesNotMatch(architecture, /centered text/);
});

// readEthosDocs checks every target. A new target must show up here too,
// or its rules get saved but never used.
test('every target round-trips: promoted to its own file, then read back', () => {
  const repoRoot = tempRepoRoot();
  const targets = Object.values(T);

  // Each target gets a different rule, so a mistake is easy to see.
  promoteEthosCandidates(
    repoRoot,
    targets.map((target) => ({ target, text: `rule belonging to ${target}` })),
  );

  for (const target of targets) {
    const doc = readDoc(ethosPath(repoRoot, target));
    assert.match(doc, new RegExp(`rule belonging to ${target}$`, 'm'));

    for (const other of targets) {
      if (other === target) continue;
      assert.doesNotMatch(doc, new RegExp(`rule belonging to ${other}$`, 'm'));
    }
  }

  const combined = readEthosDocs(repoRoot)!;
  for (const target of targets) {
    assert.match(combined, new RegExp(`rule belonging to ${target}$`, 'm'));
  }
});

test('promoteEthosCandidates appends to an existing file instead of overwriting it', () => {
  const repoRoot = tempRepoRoot();

  promoteEthosCandidates(repoRoot, [{ target: 'ETHOS_CODE', text: 'first rule' }]);
  promoteEthosCandidates(repoRoot, [{ target: 'ETHOS_CODE', text: 'second rule' }]);

  const code = readDoc(ethosPath(repoRoot, 'ETHOS_CODE'));
  assert.match(code, /first rule/);
  assert.match(code, /second rule/);
});

test('promoteEthosCandidates on an empty list writes nothing', () => {
  const repoRoot = tempRepoRoot();

  promoteEthosCandidates(repoRoot, []);

  assert.equal(fs.existsSync(ethosPath(repoRoot, 'ETHOS_CODE')), false);
});

test('promoteEthosCandidates skips a candidate that already exists in the file', () => {
  const repoRoot = tempRepoRoot();
  promoteEthosCandidates(repoRoot, [{ target: 'ETHOS_CODE', text: 'prefer small functions' }]);

  promoteEthosCandidates(repoRoot, [{ target: 'ETHOS_CODE', text: 'prefer small functions' }]);

  const code = readDoc(ethosPath(repoRoot, 'ETHOS_CODE'));
  const occurrences = code.split('prefer small functions').length - 1;
  assert.equal(occurrences, 1);
});

test('promoteEthosCandidates dedup is case-insensitive and whitespace-tolerant', () => {
  const repoRoot = tempRepoRoot();
  promoteEthosCandidates(repoRoot, [{ target: 'ETHOS_CODE', text: 'Prefer small functions' }]);

  promoteEthosCandidates(repoRoot, [{ target: 'ETHOS_CODE', text: '  prefer SMALL functions  ' }]);

  const code = readDoc(ethosPath(repoRoot, 'ETHOS_CODE'));
  const occurrences = (code.toLowerCase().match(/prefer small functions/g) ?? []).length;
  assert.equal(occurrences, 1);
});

test('promoteEthosCandidates dedups within the same batch, not just against the existing file', () => {
  const repoRoot = tempRepoRoot();

  promoteEthosCandidates(repoRoot, [
    { target: 'ETHOS_CODE', text: 'no unused abstractions' },
    { target: 'ETHOS_CODE', text: 'no unused abstractions' },
  ]);

  const code = readDoc(ethosPath(repoRoot, 'ETHOS_CODE'));
  const occurrences = code.split('no unused abstractions').length - 1;
  assert.equal(occurrences, 1);
});

test('a genuinely new candidate is still added alongside an unrelated duplicate', () => {
  const repoRoot = tempRepoRoot();
  promoteEthosCandidates(repoRoot, [{ target: 'ETHOS_CODE', text: 'rule one' }]);

  promoteEthosCandidates(repoRoot, [
    { target: 'ETHOS_CODE', text: 'rule one' },
    { target: 'ETHOS_CODE', text: 'rule two' },
  ]);

  const code = readDoc(ethosPath(repoRoot, 'ETHOS_CODE'));
  assert.match(code, /rule two/);
  assert.equal(code.split('rule one').length - 1, 1);
});

test('readEthosDocs returns null when neither ethos file exists yet', () => {
  const repoRoot = tempRepoRoot();
  assert.equal(readEthosDocs(repoRoot), null);
});

test('readEthosDocs combines both files when both exist', () => {
  const repoRoot = tempRepoRoot();
  promoteEthosCandidates(repoRoot, [
    { target: 'ETHOS_CODE', text: 'prefer composition' },
    { target: 'ETHOS_DESIGN', text: 'no centered text' },
  ]);

  const combined = readEthosDocs(repoRoot)!;

  assert.match(combined, /prefer composition/);
  assert.match(combined, /no centered text/);
});

test("readEthosDocs returns just the one file's content when only one exists", () => {
  const repoRoot = tempRepoRoot();
  promoteEthosCandidates(repoRoot, [{ target: 'ETHOS_CODE', text: 'prefer composition' }]);

  const combined = readEthosDocs(repoRoot)!;

  assert.match(combined, /prefer composition/);
  assert.doesNotMatch(combined, /centered text/);
});

test('a fresh file is seeded with both sections, and learned rules land under ## Learned', () => {
  const repoRoot = tempRepoRoot();

  promoteEthosCandidates(repoRoot, [{ target: T.CODE, text: 'prefer small functions' }]);

  const code = readDoc(ethosPath(repoRoot, T.CODE));
  assert.match(code, /^## Authored$/m);
  assert.match(code, /^## Learned$/m);

  // The rule must be BELOW the Learned heading, not above it.
  assert.ok(
    code.indexOf('prefer small functions') > code.indexOf(LEARNED_HEADING),
    'learned rule was written above ## Learned',
  );
});

// This section belongs to the human.
// Glafka must never change, reorder, or remove any line here.
test('## Authored is left byte-identical when a learned rule is appended', () => {
  const repoRoot = tempRepoRoot();
  const filePath = ethosPath(repoRoot, T.SECURITY);
  writeDoc(
    filePath,
    `# ETHOS_SECURITY\n\n## Authored\n\n- never log request bodies\n- all queries filter by tenant_id\n\n## Learned\n\n`,
  );
  const before = readDoc(filePath);
  const authoredBefore = before.slice(
    before.indexOf(AUTHORED_HEADING),
    before.indexOf(LEARNED_HEADING),
  );

  promoteEthosCandidates(repoRoot, [{ target: T.SECURITY, text: '401 before 403' }]);

  const after = readDoc(filePath);
  const authoredAfter = after.slice(
    after.indexOf(AUTHORED_HEADING),
    after.indexOf(LEARNED_HEADING),
  );
  assert.equal(authoredAfter, authoredBefore);
  assert.match(after, /401 before 403/);
});

// If an agent suggests something you already wrote, nothing should change.
// It must not add a duplicate line.
test('a candidate already written by hand under ## Authored is not re-added', () => {
  const repoRoot = tempRepoRoot();
  writeDoc(
    ethosPath(repoRoot, T.CODE),
    `# ETHOS_CODE\n\n## Authored\n\n- prefer small functions\n\n## Learned\n\n`,
  );

  promoteEthosCandidates(repoRoot, [{ target: T.CODE, text: 'Prefer small functions' }]);

  const code = readDoc(ethosPath(repoRoot, T.CODE));
  assert.equal((code.toLowerCase().match(/prefer small functions/g) ?? []).length, 1);
});

// Hand-written rules must reach the agent, even if no ticket
// has ever been closed in this project.
test('readEthosDocs returns hand-authored rules with no candidate ever promoted', () => {
  const repoRoot = tempRepoRoot();
  writeDoc(
    ethosPath(repoRoot, T.ARCHITECTURE),
    `# ETHOS_ARCHITECTURE\n\n## Authored\n\n- the api layer never imports from workers\n\n## Learned\n\n`,
  );

  assert.match(readEthosDocs(repoRoot)!, /the api layer never imports from workers/);
});

// If the "## Learned" heading gets deleted by mistake, no content is lost.
// Rules must still go somewhere that gets read.
test('a file with no ## Learned heading gets one, keeping every existing line', () => {
  const repoRoot = tempRepoRoot();
  writeDoc(ethosPath(repoRoot, T.CODE), `# ETHOS_CODE\n\n- an old flat rule\n`);

  promoteEthosCandidates(repoRoot, [{ target: T.CODE, text: 'a new rule' }]);

  const code = readDoc(ethosPath(repoRoot, T.CODE));
  assert.match(code, /an old flat rule/);
  assert.match(code, /^## Learned$/m);
  assert.ok(code.indexOf('a new rule') > code.indexOf(LEARNED_HEADING));
});

// Old bug: new rules were added at the end of the file, not the end
// of the Learned section, so they could land in the wrong section and get ignored.
test('a Learned rule lands under Learned even when Proposed comes after it in the file', () => {
  const repoRoot = tempRepoRoot();
  writeDoc(
    ethosPath(repoRoot, T.CODE),
    `# ETHOS_CODE\n\n${AUTHORED_HEADING}\n\n${LEARNED_HEADING}\n\n- old learned rule\n\n${PROPOSED_HEADING}\n\n- a pending guess\n`,
  );

  promoteEthosCandidates(repoRoot, [
    { target: T.CODE, text: 'errors are wrapped at the boundary' },
  ]);

  const code = readDoc(ethosPath(repoRoot, T.CODE));
  const learnedIdx = code.indexOf(LEARNED_HEADING);
  const proposedIdx = code.indexOf(PROPOSED_HEADING);
  const newRuleIdx = code.indexOf('errors are wrapped at the boundary');

  assert.ok(newRuleIdx > learnedIdx, 'new rule must come after the Learned heading');
  assert.ok(newRuleIdx < proposedIdx, 'new rule must land BEFORE Proposed, not inside it');
  assert.match(code, /old learned rule/);
  assert.match(code, /a pending guess/);
  // This checks the rule is actually used, not silently dropped.
  assert.match(readEthosDocs(repoRoot)!, /errors are wrapped at the boundary/);
});

// Same bug, different order: Authored comes after Learned.
// The old code could wrongly write into Authored, which must never happen.
test('a Learned rule does not spill into Authored when Authored comes after Learned in the file', () => {
  const repoRoot = tempRepoRoot();
  writeDoc(
    ethosPath(repoRoot, T.CODE),
    `# ETHOS_CODE\n\n${LEARNED_HEADING}\n\n- old learned rule\n\n${AUTHORED_HEADING}\n\n- a human wrote this by hand\n`,
  );

  promoteEthosCandidates(repoRoot, [{ target: T.CODE, text: 'a new agent conclusion' }]);

  const code = readDoc(ethosPath(repoRoot, T.CODE));
  const learnedIdx = code.indexOf(LEARNED_HEADING);
  const authoredIdx = code.indexOf(AUTHORED_HEADING);
  const newRuleIdx = code.indexOf('a new agent conclusion');

  assert.ok(
    newRuleIdx > learnedIdx && newRuleIdx < authoredIdx,
    'new rule must land before Authored, not inside it',
  );
  assert.match(code, /a human wrote this by hand/);
});

// Only categories listed in categories.json are used.
// An old file for a removed category stays on disk but is ignored.
test('readEthosDocs ignores a file whose category is not in categories.json', () => {
  const repoRoot = tempRepoRoot();
  writeDoc(
    path.join(repoRoot, 'docs/glafka/ethos/categories.json'),
    JSON.stringify([{ name: 'DOMAIN', hint: 'our billing rules' }]),
  );
  writeDoc(
    ethosPath(repoRoot, 'ETHOS_DOMAIN'),
    `# ETHOS_DOMAIN\n\n## Learned\n\n- invoices are immutable\n`,
  );
  writeDoc(
    ethosPath(repoRoot, 'ETHOS_CODE'),
    `# ETHOS_CODE\n\n## Learned\n\n- a rule from a deleted category\n`,
  );

  const combined = readEthosDocs(repoRoot)!;

  assert.match(combined, /invoices are immutable/);
  assert.doesNotMatch(combined, /deleted category/);
});

// The Proposed section lets odysse suggest rules early.
// But nothing takes effect until a human approves it.
test('## Proposed is NOT injected into prompts, while Authored and Learned are', () => {
  const repoRoot = tempRepoRoot();
  writeDoc(
    ethosPath(repoRoot, T.CODE),
    `# ETHOS_CODE\n\n## Authored\n\n- a rule I wrote\n\n## Proposed\n\n- something odysse noticed\n\n## Learned\n\n- a rule I approved\n`,
  );

  const combined = readEthosDocs(repoRoot)!;

  assert.match(combined, /a rule I wrote/);
  assert.match(combined, /a rule I approved/);
  assert.doesNotMatch(combined, /something odysse noticed/);
});

test('a file with only proposals contributes nothing to the prompt', () => {
  const repoRoot = tempRepoRoot();
  writeDoc(
    ethosPath(repoRoot, T.CODE),
    `# ETHOS_CODE\n\n## Authored\n\n## Proposed\n\n- only an observation\n\n## Learned\n\n`,
  );

  assert.equal(readEthosDocs(repoRoot), null);
});

test('readProposals flattens across category files, numbered in category order', () => {
  const repoRoot = tempRepoRoot();
  writeDoc(
    ethosPath(repoRoot, T.CODE),
    `# x\n\n## Proposed\n\n- code one\n- code two\n\n## Learned\n\n`,
  );
  writeDoc(ethosPath(repoRoot, T.SECURITY), `# x\n\n## Proposed\n\n- sec one\n\n## Learned\n\n`);

  const proposals = readProposals(repoRoot);

  assert.deepEqual(
    proposals.map((p) => p.text),
    ['code one', 'code two', 'sec one'],
  );
  assert.deepEqual([...new Set(proposals.map((p) => p.source))], ['odysse']);
});

test('decideProposals moves the kept ones into ## Learned', () => {
  const repoRoot = tempRepoRoot();
  writeDoc(
    ethosPath(repoRoot, T.CODE),
    `# x\n\n## Authored\n\n## Proposed\n\n- keep me\n- drop me\n\n## Learned\n\n`,
  );

  const { kept, decided } = decideProposals(repoRoot, [1]);

  assert.deepEqual(
    kept.map((p) => p.text),
    ['keep me'],
  );
  assert.equal(decided, 2);

  const code = readDoc(ethosPath(repoRoot, T.CODE));
  assert.ok(code.indexOf('keep me') > code.indexOf(LEARNED_HEADING));
  // Turned down is written down, not destroyed, so a wrong pick can be undone.
  assert.ok(code.indexOf('drop me') > code.indexOf(DROPPED_HEADING));
  assert.match(readEthosDocs(repoRoot)!, /keep me/);
  assert.doesNotMatch(readEthosDocs(repoRoot)!, /drop me/);
});

// If a rejected rule stayed listed, it would be offered again later.
// That would make a human say no twice.
test('## Proposed is cleared either way, so nothing is re-offered', () => {
  // Cleared means moved to ## Dropped, not deleted — see decideProposals.
  const repoRoot = tempRepoRoot();
  writeDoc(ethosPath(repoRoot, T.CODE), `# x\n\n## Proposed\n\n- a\n- b\n\n## Learned\n\n`);

  decideProposals(repoRoot, []);

  assert.deepEqual(readProposals(repoRoot), []);
  const code = readDoc(ethosPath(repoRoot, T.CODE));
  assert.match(code, /## Proposed/);
  // Under ## Dropped they are neither offered again nor in force nor lost.
  assert.ok(code.indexOf('- a') > code.indexOf(DROPPED_HEADING));
  assert.ok(code.indexOf('- b') > code.indexOf(DROPPED_HEADING));
  assert.equal(readEthosDocs(repoRoot), null);
});

// Duplicate checks must ignore Proposed rules.
// Otherwise a matching rule could never be approved.
test('a ticket candidate matching an un-accepted proposal is still recorded', () => {
  const repoRoot = tempRepoRoot();
  writeDoc(
    ethosPath(repoRoot, T.CODE),
    `# x\n\n## Authored\n\n## Proposed\n\n- errors wrap at the boundary\n\n## Learned\n\n`,
  );

  promoteEthosCandidates(repoRoot, [{ target: T.CODE, text: 'errors wrap at the boundary' }]);

  // We use lastIndexOf because the same text also appears in Proposed above.
  const code = readDoc(ethosPath(repoRoot, T.CODE));
  assert.ok(
    code.lastIndexOf('errors wrap at the boundary') > code.indexOf(LEARNED_HEADING),
    'candidate was not appended under ## Learned',
  );
  // This rule is now active. The old proposal was not.
  assert.match(readEthosDocs(repoRoot)!, /errors wrap at the boundary/);
});

test('decideProposals on a project with no proposals is a no-op', () => {
  assert.deepEqual(decideProposals(tempRepoRoot(), [1]), { kept: [], decided: 0 });
});

// Old bug: Proposed was cleared before Learned was written, in two
// separate steps. If it failed partway, all the rules were lost.
test('a decision that fails part-way does not lose the rules it kept', () => {
  const repoRoot = tempRepoRoot();
  const codePath = ethosPath(repoRoot, T.CODE);
  const designPath = ethosPath(repoRoot, T.DESIGN);
  writeDoc(codePath, `# c\n\n## Authored\n\n## Proposed\n\n- code rule\n\n## Learned\n\n`);
  writeDoc(designPath, `# d\n\n## Authored\n\n## Proposed\n\n- design rule\n\n## Learned\n\n`);

  // writeFile saves to a temp file first, then renames it.
  // A folder with that same name makes this one write fail on purpose.
  fs.mkdirSync(`${designPath}.tmp-${process.pid}`, { recursive: true });

  // Keep the CODE rule. Reject the DESIGN rule.
  assert.throws(() => decideProposals(repoRoot, [1]));

  const code = readDoc(codePath);
  assert.match(
    code.split(LEARNED_HEADING)[1] ?? '',
    /- code rule/,
    'the kept rule must have been promoted before anything was cleared',
  );
});

test('a successful decision still clears Proposed and fills Learned', () => {
  const repoRoot = tempRepoRoot();
  const filePath = ethosPath(repoRoot, T.CODE);
  writeDoc(filePath, `# x\n\n## Authored\n\n## Proposed\n\n- keep me\n- drop me\n\n## Learned\n\n`);

  const { kept, decided } = decideProposals(repoRoot, [1]);

  assert.equal(decided, 2);
  assert.deepEqual(
    kept.map((k) => k.text),
    ['keep me'],
  );
  const after = readDoc(filePath);
  assert.doesNotMatch(after.split(LEARNED_HEADING)[0], /- drop me/);
  assert.match(after.split(LEARNED_HEADING)[1], /- keep me/);
});
