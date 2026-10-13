import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeGitRepo } from '../helpers/gitFixture.js';
import { proposeEthos, readProposals, decideProposals } from '../../src/memory/ethos.js';
import { ethosPath, readDoc, writeDoc } from '../../src/memory/docsStore.js';

// odysse used to edit these files itself. It goes through proposeEthos now, so there is one write
// path and `denyWithin: docs/glafka/ethos/**` can be enforced instead of worked around.

test('proposeEthos creates the file with all three headings and files the rule under Proposed', () => {
  const repoRoot = makeGitRepo();

  assert.equal(
    proposeEthos(repoRoot, { target: 'ETHOS_CODE', text: 'wrap errors at the boundary' }),
    true,
  );

  const doc = readDoc(ethosPath(repoRoot, 'ETHOS_CODE'));
  assert.match(doc, /## Authored/);
  assert.match(doc, /## Proposed/);
  assert.match(doc, /## Learned/);
  // The rule sits under Proposed, not at the end of the file.
  const proposedAt = doc.indexOf('## Proposed');
  const learnedAt = doc.indexOf('## Learned');
  const ruleAt = doc.indexOf('- wrap errors at the boundary');
  assert.ok(ruleAt > proposedAt && ruleAt < learnedAt, 'rule must land inside Proposed');
});

test('proposeEthos reports a repeat instead of writing it twice', () => {
  const repoRoot = makeGitRepo();

  assert.equal(proposeEthos(repoRoot, { target: 'ETHOS_CODE', text: 'one rule' }), true);
  assert.equal(proposeEthos(repoRoot, { target: 'ETHOS_CODE', text: 'ONE RULE' }), false);

  const doc = readDoc(ethosPath(repoRoot, 'ETHOS_CODE'));
  assert.equal(doc.split('- one rule').length - 1, 1);
});

// A rule the human already ruled on is in force. Proposing it again is noise,
// so the check spans every section, not just Proposed.
test('proposeEthos skips a rule that is already in Authored or Learned', () => {
  const repoRoot = makeGitRepo();
  writeDoc(
    ethosPath(repoRoot, 'ETHOS_CODE'),
    '# ETHOS_CODE\n\n## Authored\n\n- already decided\n\n## Proposed\n\n## Learned\n\n- also decided\n',
  );

  assert.equal(proposeEthos(repoRoot, { target: 'ETHOS_CODE', text: 'already decided' }), false);
  assert.equal(proposeEthos(repoRoot, { target: 'ETHOS_CODE', text: 'also decided' }), false);
});

test('proposeEthos never touches a decided rule when it adds a new one', () => {
  const repoRoot = makeGitRepo();
  const filePath = ethosPath(repoRoot, 'ETHOS_CODE');
  writeDoc(
    filePath,
    '# ETHOS_CODE\n\n## Authored\n\n- keep me\n\n## Proposed\n\n## Learned\n\n- keep me too\n',
  );

  proposeEthos(repoRoot, { target: 'ETHOS_CODE', text: 'brand new' });

  const doc = readDoc(filePath);
  assert.match(doc, /- keep me\n/);
  assert.match(doc, /- keep me too/);
  assert.match(doc, /- brand new/);
});

test('proposeEthos refuses a multi-line rule — one rule is one line', () => {
  const repoRoot = makeGitRepo();
  assert.throws(
    () => proposeEthos(repoRoot, { target: 'ETHOS_CODE', text: 'line one\nline two' }),
    /one rule is one line/,
  );
});

test('proposeEthos refuses empty text', () => {
  const repoRoot = makeGitRepo();
  assert.throws(() => proposeEthos(repoRoot, { target: 'ETHOS_CODE', text: '   ' }), /empty rule/);
});

// The whole point: what proposeEthos writes must be what the existing review
// flow reads. A write path the human's --keep step cannot see is useless.
test('a proposed rule shows up in readProposals and can be kept', () => {
  const repoRoot = makeGitRepo();
  proposeEthos(repoRoot, { target: 'ETHOS_CODE', text: 'keep this one' });
  proposeEthos(repoRoot, { target: 'ETHOS_CODE', text: 'drop this one' });

  const pending = readProposals(repoRoot);
  assert.equal(pending.length, 2);
  assert.equal(pending[0]!.source, 'odysse');

  const { kept, decided } = decideProposals(repoRoot, [1]);
  assert.equal(decided, 2);
  assert.equal(kept.length, 1);

  const doc = readDoc(ethosPath(repoRoot, 'ETHOS_CODE'));
  const learnedAt = doc.indexOf('## Learned');
  assert.ok(doc.indexOf('- keep this one') > learnedAt, 'kept rule moves to Learned');
  // The one turned down moves to Dropped rather than being deleted, so a
  // mistaken pick is a hand-edit away from fixed.
  assert.ok(doc.indexOf('- drop this one') > doc.indexOf('## Dropped'), 'dropped rule is kept');
  assert.equal(readProposals(repoRoot).length, 0);
});

// An ethos file written before Proposed existed must not lose the rule.
test('proposeEthos adds a Proposed heading to an older file instead of dropping the rule', () => {
  const repoRoot = makeGitRepo();
  const filePath = ethosPath(repoRoot, 'ETHOS_CODE');
  writeDoc(filePath, '# ETHOS_CODE\n\n## Authored\n\n- old rule\n\n## Learned\n\n- learned rule\n');

  assert.equal(proposeEthos(repoRoot, { target: 'ETHOS_CODE', text: 'new observation' }), true);

  const doc = readDoc(filePath);
  assert.match(doc, /## Proposed/);
  assert.equal(
    readProposals(repoRoot).some((p) => p.text === 'new observation'),
    true,
  );
  // The order stays Authored, Proposed, Learned.
  assert.ok(doc.indexOf('## Proposed') < doc.indexOf('## Learned'));
  assert.match(doc, /- old rule/);
  assert.match(doc, /- learned rule/);
});

test('the file is created only when a rule is actually filed', () => {
  const repoRoot = makeGitRepo();
  assert.equal(fs.existsSync(ethosPath(repoRoot, 'ETHOS_CODE')), false);
  proposeEthos(repoRoot, { target: 'ETHOS_CODE', text: 'a rule' });
  assert.equal(fs.existsSync(ethosPath(repoRoot, 'ETHOS_CODE')), true);
});

// Bullets added one at a time must form ONE list. A blank line between them
// splits it into several, which reads as unrelated rules.
test('rules filed one at a time end up as a single list', () => {
  const repoRoot = makeGitRepo();
  proposeEthos(repoRoot, { target: 'ETHOS_CODE', text: 'first rule' });
  proposeEthos(repoRoot, { target: 'ETHOS_CODE', text: 'second rule' });

  assert.match(readDoc(ethosPath(repoRoot, 'ETHOS_CODE')), /- first rule\n- second rule/);
});
