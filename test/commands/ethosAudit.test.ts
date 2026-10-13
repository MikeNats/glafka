import { test } from 'node:test';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { makeGitRepo } from '../helpers/gitFixture.js';
import { ethosPath, readDoc, writeDoc } from '../../src/memory/docsStore.js';
import { DROPPED_HEADING, LEARNED_HEADING } from '../../src/memory/ethos.js';
import { makeTempDir } from '../helpers/tempDir.js';
import {
  rulesInForce,
  buildAuditPrompt,
  parseAuditResponse,
  applyAudit,
  readAuditProposals,
  writeAuditProposals,
  clearAuditProposals,
  assertAuditDecidable,
  deadReferences,
  auditFileList,
  auditIsDue,
  writeAuditWatermark,
  AUDIT_DUE_THRESHOLD,
  readAuditWatermark,
} from '../../src/memory/ethosAudit/ethosAudit.js';

const DOC = `# ETHOS_CODE

## Authored

- hand written rule, never touched by an LLM

## Proposed

- a guess nobody ruled on

## Learned

- Wrap errors at the boundary, never mid-call
- Errors are wrapped at the boundary
- use PropTypes for component props
`;

function repoWithRules(): string {
  const repoRoot = makeGitRepo();
  writeDoc(ethosPath(repoRoot, 'ETHOS_CODE'), DOC);
  return repoRoot;
}

// Auditing a guess nobody has ruled on is money spent on nothing.
test('only rules in force are audited — Proposed is left out', () => {
  const rules = rulesInForce(repoWithRules());

  assert.equal(rules.length, 4);
  assert.equal(
    rules.some((r) => r.text === 'a guess nobody ruled on'),
    false,
  );
});

test('the prompt says that proposing nothing is a correct answer', () => {
  const prompt = buildAuditPrompt(rulesInForce(repoWithRules()), []);

  assert.match(prompt, /Proposing nothing is a correct and common answer/);
  // Rewording for style is exactly the low-value churn to refuse.
  assert.match(prompt, /Rewording for style/);
  assert.match(prompt, /copied EXACTLY/);
});

// Everything below is about not letting one bad line from a model edit a
// permanent file. The cost of dropping a proposal is one more audit run.

test('a proposal naming a rule that does not exist is dropped', () => {
  const rules = rulesInForce(repoWithRules());
  const answer = '[{"action":"retire","rules":["a rule nobody wrote"],"replacement":[],"why":"x"}]';

  assert.equal(parseAuditResponse(answer, rules).length, 0);
});

// A merge that replaces two rules with nothing is a retire wearing the wrong
// name, and would delete a rule the human never agreed to lose.
test('a merge or split with an empty replacement is dropped', () => {
  const rules = rulesInForce(repoWithRules());
  const answer =
    '[{"action":"merge","rules":["Errors are wrapped at the boundary"],"replacement":[],"why":"x"}]';

  assert.equal(parseAuditResponse(answer, rules).length, 0);
});

test('an unknown action is dropped', () => {
  const rules = rulesInForce(repoWithRules());
  const answer = '[{"action":"rewrite","rules":["use PropTypes for component props"],"why":"x"}]';

  assert.equal(parseAuditResponse(answer, rules).length, 0);
});

test('an answer with no readable JSON yields nothing, rather than throwing', () => {
  assert.deepEqual(parseAuditResponse('I had a look and it all seems fine!', []), []);
  assert.deepEqual(parseAuditResponse('[not json', []), []);
});

test('prose around the JSON is tolerated', () => {
  const rules = rulesInForce(repoWithRules());
  const answer = `Sure, here you go:
[{"action":"retire","rules":["use PropTypes for component props"],"replacement":[],"why":"TS"}]
Hope that helps!`;

  assert.equal(parseAuditResponse(answer, rules).length, 1);
});

// `## Authored` is what a person wrote by hand. An LLM does not get to edit
// it, whatever it proposes and whatever the human clicks.
test('a proposal touching Authored is reported and skipped, never applied', () => {
  const repoRoot = repoWithRules();
  const rules = rulesInForce(repoRoot);
  const answer =
    '[{"action":"retire","rules":["hand written rule, never touched by an LLM"],"replacement":[],"why":"x"}]';

  const proposals = parseAuditResponse(answer, rules);
  const { applied, skippedAuthored } = applyAudit(repoRoot, proposals, [1]);

  assert.equal(applied.length, 0);
  assert.equal(skippedAuthored.length, 1);
  assert.match(readDoc(ethosPath(repoRoot, 'ETHOS_CODE')), /hand written rule/);
});

test('a merge collapses the duplicates and keeps the wording in place', () => {
  const repoRoot = repoWithRules();
  const rules = rulesInForce(repoRoot);
  const answer = JSON.stringify([
    {
      action: 'merge',
      rules: ['Wrap errors at the boundary, never mid-call', 'Errors are wrapped at the boundary'],
      replacement: ['Wrap errors at the boundary, never mid-call'],
      why: 'same rule twice',
    },
  ]);

  applyAudit(repoRoot, parseAuditResponse(answer, rules), [1]);

  const doc = readDoc(ethosPath(repoRoot, 'ETHOS_CODE'));
  assert.equal(doc.includes('Errors are wrapped at the boundary'), false);
  assert.match(doc, /- Wrap errors at the boundary, never mid-call/);
  // The Proposed section is untouched by an audit.
  assert.match(doc, /a guess nobody ruled on/);
});

test('only the chosen proposals are applied', () => {
  const repoRoot = repoWithRules();
  const rules = rulesInForce(repoRoot);
  const answer = JSON.stringify([
    {
      action: 'retire',
      rules: ['use PropTypes for component props'],
      replacement: [],
      why: 'TS',
    },
    {
      action: 'retire',
      rules: ['Errors are wrapped at the boundary'],
      replacement: [],
      why: 'dup',
    },
  ]);

  const { applied } = applyAudit(repoRoot, parseAuditResponse(answer, rules), [2]);

  assert.equal(applied.length, 1);
  const doc = readDoc(ethosPath(repoRoot, 'ETHOS_CODE'));
  assert.match(doc, /use PropTypes/);
  // Retired means out of force, not gone: it moves under ## Dropped so a
  // wrong call can be undone by hand.
  const inForce = doc.slice(0, doc.indexOf(DROPPED_HEADING));
  assert.equal(inForce.includes('Errors are wrapped at the boundary'), false);
  assert.match(doc.slice(doc.indexOf(DROPPED_HEADING)), /- Errors are wrapped at the boundary/);
});

// The pass costs money. A --keep run must answer the proposals already on
// disk, not pay for a fresh set that says something different.
test('proposals survive between the audit run and the decision', () => {
  const repoRoot = makeGitRepo();
  const proposals = [
    { action: 'retire', target: 'ETHOS_CODE', rules: ['x'], replacement: [], why: 'y' },
  ];

  writeAuditProposals(repoRoot, proposals);
  assert.deepEqual(readAuditProposals(repoRoot), proposals);

  clearAuditProposals(repoRoot);
  assert.deepEqual(readAuditProposals(repoRoot), []);
});

test('nothing is applied until a person answers', () => {
  const proposals = [
    { action: 'retire', target: 'ETHOS_CODE', rules: ['x'], replacement: [], why: 'stale' },
  ];

  assert.throws(() => assertAuditDecidable(proposals, null), /awaiting your decision/);
  // With an answer, it stands aside.
  assertAuditDecidable(proposals, 'none');
  // And with nothing to decide there is nothing to stop.
  assertAuditDecidable([], null);
});

// `## Authored` is rules a person wrote by hand, and the guard exists so an LLM can
// never edit them. It resolved rules to a section through a Map keyed on text — which can only remember ONE section — and then removed matching bullets from the WHOLE file. A rule text present in both Authored and Learned therefore lost its Authored copy.
test('a rule text in two sections does not lose its Authored copy', () => {
  const repoRoot = makeTempDir('audit15');
  const ethosDir = path.join(repoRoot, 'docs', 'glafka', 'ethos');
  fs.mkdirSync(ethosDir, { recursive: true });

  const shared = 'Wrap errors at the boundary';
  fs.writeFileSync(
    path.join(ethosDir, 'ETHOS_CODE.md'),
    [
      '# ETHOS_CODE',
      '',
      '## Authored',
      '',
      `- ${shared}`,
      '',
      '## Proposed',
      '',
      '## Learned',
      '',
      `- ${shared}`,
      '',
    ].join('\n'),
  );

  const { applied, skippedAuthored } = applyAudit(
    repoRoot,
    [
      {
        action: 'retire',
        target: 'ETHOS_CODE',
        rules: [shared],
        replacement: [],
        why: 'duplicate',
      },
    ],
    [1],
  );

  assert.equal(applied.length, 0, 'a proposal touching Authored must not apply');
  assert.equal(skippedAuthored.length, 1, 'and it must be reported');

  const after = fs.readFileSync(path.join(ethosDir, 'ETHOS_CODE.md'), 'utf8');
  const authoredBody = after.slice(after.indexOf('## Authored'), after.indexOf('## Proposed'));
  assert.ok(authoredBody.includes(shared), 'the hand-written rule must survive');

  fs.rmSync(repoRoot, { recursive: true, force: true });
});

function repoWithLearned(bullets: string): string {
  const repoRoot = makeGitRepo();
  writeDoc(
    ethosPath(repoRoot, 'ETHOS_CODE'),
    `# ETHOS_CODE\n\n## Authored\n\n## Proposed\n\n${LEARNED_HEADING}\n\n${bullets}\n\n${DROPPED_HEADING}\n\n`,
  );
  return repoRoot;
}

test('a retired rule is moved to Dropped, not deleted', () => {
  const repoRoot = repoWithLearned('- uses the retired Foo library');

  applyAudit(
    repoRoot,
    [
      {
        action: 'retire',
        target: 'ETHOS_CODE',
        rules: ['uses the retired Foo library'],
        replacement: [],
        why: 'gone',
      },
    ],
    [1],
  );

  const doc = readDoc(ethosPath(repoRoot, 'ETHOS_CODE'));
  const learned = doc.slice(doc.indexOf(LEARNED_HEADING), doc.indexOf(DROPPED_HEADING));

  assert.equal(learned.includes('retired Foo library'), false);
  assert.match(doc.slice(doc.indexOf(DROPPED_HEADING)), /- uses the retired Foo library/);
});

// A merge already replaces its originals with new wording. Copying them to
// Dropped as well would grow the file on every compaction.
test('a merge does not leave its originals under Dropped', () => {
  const repoRoot = repoWithLearned(
    '- wrap errors at the boundary\n- errors are wrapped at the boundary',
  );

  applyAudit(
    repoRoot,
    [
      {
        action: 'merge',
        target: 'ETHOS_CODE',
        rules: ['wrap errors at the boundary', 'errors are wrapped at the boundary'],
        replacement: ['Wrap errors at the boundary, never mid-call.'],
        why: 'same rule twice',
      },
    ],
    [1],
  );

  const doc = readDoc(ethosPath(repoRoot, 'ETHOS_CODE'));
  assert.match(doc, /- Wrap errors at the boundary, never mid-call\./);
  assert.equal(doc.slice(doc.indexOf(DROPPED_HEADING)).includes('- wrap errors'), false);
});

const FILES = ['src/parser/lex.ts', 'src/api/routes.ts'];
const rule = (text: string) => [{ target: 'ETHOS_CODE', section: LEARNED_HEADING, text }];

test('a path that exists is not reported dead', () => {
  assert.deepEqual(deadReferences(rule('Helpers live in src/parser/.'), FILES), []);
});

test('a path that is really gone is reported', () => {
  const dead = deadReferences(rule('Never edit legacy/vendor/old.js by hand.'), FILES);

  assert.equal(dead.length, 1);
  assert.deepEqual(dead[0]!.missing, ['legacy/vendor/old.js']);
});

// A scope marker is a pattern, not a path that has to exist. The token regex
// cannot match `*` at all, so no glob ever reaches the presence check.
test('a glob is not treated as a path', () => {
  assert.deepEqual(
    deadReferences(rule('[scope: **/migrations/**] Migrations are reversible.'), FILES),
    [],
  );
});

// THE FAILURE THIS WHOLE STEP EXISTS TO PREVENT. English written with a slash
// is not a path. "authn/authz" and "CI/CD" are both in glafka's own
// DEFAULT_CATEGORIES hints, so rules WILL be written with them. Reporting one
// as a missing file hands the model fake evidence — under a heading that calls
// itself "fact, not opinion" — and it retires a rule that was never wrong.
test('English written with a slash is never reported as a missing file', () => {
  for (const text of [
    'authn/authz is checked on every route.',
    'CI/CD runs the same checks as the pre-commit hook.',
    'Keep the client/server split; do not leak one into the other.',
    'Validate input/output at the boundary and/or in the adapter.',
    'See https://example.com/docs/style.html for the long version.',
  ]) {
    assert.deepEqual(deadReferences(rule(text), FILES), [], text);
  }
});

// A folder gone from under a directory that DOES exist.
test('a missing folder under a real root is caught even with no extension', () => {
  const dead = deadReferences(rule('Adapters live in src/adapters/.'), FILES);

  assert.deepEqual(dead[0]!.missing, ['src/adapters']);
});

// git ls-files hides ignored paths, so a rule about one looked deleted. Those
// are exactly the rules — secrets, build output — worst to retire by mistake.
test('a path inside a git-ignored directory is not reported dead', () => {
  const withIgnored = [...FILES, 'dist/', '.env.local'];

  assert.deepEqual(deadReferences(rule('Never commit .env.local.'), withIgnored), []);
  assert.deepEqual(deadReferences(rule('Never hand-edit dist/bundle.js.'), withIgnored), []);
});

test('the prompt states dead paths as fact, and says so when there are none', () => {
  const rules = rule('Never edit legacy/vendor/old.js by hand.');

  assert.match(buildAuditPrompt(rules, deadReferences(rules, FILES)), /legacy\/vendor\/old\.js/);
  assert.match(buildAuditPrompt(rules, []), /Every path named in these rules still exists/);
});

function repoWithRuleCount(count: number): string {
  return repoWithLearned(Array.from({ length: count }, (_, i) => `- rule number ${i}`).join('\n'));
}

test('below the threshold no audit is due', () => {
  assert.equal(auditIsDue(repoWithRuleCount(AUDIT_DUE_THRESHOLD - 1)).due, false);
});

test('at the threshold an audit is due, and the counts are reported', () => {
  const result = auditIsDue(repoWithRuleCount(AUDIT_DUE_THRESHOLD));

  assert.equal(result.due, true);
  assert.equal(result.count, AUDIT_DUE_THRESHOLD);
  assert.equal(result.grown, AUDIT_DUE_THRESHOLD);
});

// After an audit the count starts again, or it would be due on every push
// from then on.
test('a fresh watermark makes it not due again until the rules grow', () => {
  const repoRoot = repoWithRuleCount(AUDIT_DUE_THRESHOLD);
  writeAuditWatermark(repoRoot, AUDIT_DUE_THRESHOLD);

  assert.equal(auditIsDue(repoRoot).due, false);
});

test('a project with no rules is never due', () => {
  assert.equal(auditIsDue(makeGitRepo()).due, false);
});

// A retire shrinks the rule count below the watermark. "-3 since the last
// compaction" is not a number worth printing to anyone.
test('growth never reads as negative after rules are retired', () => {
  const repoRoot = repoWithRuleCount(2);
  writeAuditWatermark(repoRoot, 10);

  const result = auditIsDue(repoRoot);
  assert.equal(result.grown, 0);
  assert.equal(result.due, false);
});

// The listing comes from git. If git cannot answer, judging against an empty
// repo reports EVERY path as missing — under a heading that calls itself
// checked fact. Silence is the only safe answer with no evidence.
test('no file listing means no dead paths reported, not all of them', () => {
  assert.deepEqual(deadReferences(rule('Helpers live in src/parser/lex.ts.'), []), []);
});

test('a repo git cannot read yields an empty listing instead of throwing', () => {
  assert.deepEqual(auditFileList(makeTempDir('not-a-git-repo')), []);
});

// Retire a rule, move it back up by hand, retire it again. Without a guard
// that loop grows ## Dropped by one copy every time round.
test('retiring a rule already under Dropped does not add a second copy', () => {
  const repoRoot = makeGitRepo();
  writeDoc(
    ethosPath(repoRoot, 'ETHOS_CODE'),
    `# ETHOS_CODE\n\n${LEARNED_HEADING}\n\n- dupe\n\n${DROPPED_HEADING}\n\n- dupe\n`,
  );

  applyAudit(
    repoRoot,
    [{ action: 'retire', target: 'ETHOS_CODE', rules: ['dupe'], replacement: [], why: 'x' }],
    [1],
  );

  const dropped = readDoc(ethosPath(repoRoot, 'ETHOS_CODE'));
  assert.equal((dropped.slice(dropped.indexOf(DROPPED_HEADING)).match(/- dupe/g) ?? []).length, 1);
});

// A push can leave proposals waiting. Typing the bare command to look at them
// used to run a whole second pass and overwrite the answer being read.
test('a pass over pending proposals replaces them — so callers must check first', () => {
  const repoRoot = makeGitRepo();
  writeDoc(ethosPath(repoRoot, 'ETHOS_CODE'), `# E\n\n${LEARNED_HEADING}\n\n- a rule\n`);
  writeAuditProposals(repoRoot, [
    { action: 'retire', target: 'ETHOS_CODE', rules: ['a rule'], replacement: [], why: 'pending' },
  ]);

  // Both call sites guard on this before spending anything.
  assert.equal(readAuditProposals(repoRoot).length, 1);
  assert.equal(readAuditProposals(repoRoot)[0]!.why, 'pending');
});

// The whole risk of this check is arguing the model into retiring a correct
// rule. Prose containing a slash is the shape that does it, so the guard
// against it is pinned here rather than left to one example.
test('numbers, dates and wrong case are never claimed as repository paths', () => {
  const files = ['src/parser/lex.ts', 'package.json'];
  for (const text of [
    'Node >=20/22 only.',
    'Frozen on 2026/08/07.',
    'Keep coverage above 9/10.',
    'See SRC/Parser for this.',
    'Never edit src\\parser\\lex.ts.',
    'Deps live in package.json, see src/parser/lex.ts.',
  ]) {
    assert.deepEqual(deadReferences(rule(text), files), [], text);
  }
});

test('a path in backticks is judged without them', () => {
  assert.deepEqual(deadReferences(rule('Use `src/gone.ts` here.'), FILES)[0]!.missing, [
    'src/gone.ts',
  ]);
});

// Proposals sit on disk between the pass and the decision. A human can edit
// the rule in that window, and the stored proposal then names text that is
// no longer there.
test('a proposal about wording the human has since changed is skipped, not forced', () => {
  const repoRoot = makeGitRepo();
  writeDoc(ethosPath(repoRoot, 'ETHOS_CODE'), `# E\n\n${LEARNED_HEADING}\n\n- the REWORDED rule\n`);

  const { applied } = applyAudit(
    repoRoot,
    [
      {
        action: 'retire',
        target: 'ETHOS_CODE',
        rules: ['the ORIGINAL wording'],
        replacement: [],
        why: 'x',
      },
    ],
    [1],
  );

  assert.equal(applied.length, 0);
  assert.match(readDoc(ethosPath(repoRoot, 'ETHOS_CODE')), /REWORDED/);
});

// Both files are read in the middle of a push. Neither is worth failing one
// over, so both fall back rather than throw.
test('a hand-mangled watermark or proposals file falls back instead of throwing', () => {
  const repoRoot = makeGitRepo();
  fs.mkdirSync(path.join(repoRoot, '.glafka'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, '.glafka', 'ethos-audit.json'), '{ not json');
  assert.equal(readAuditWatermark(repoRoot), 0);

  fs.mkdirSync(path.join(repoRoot, 'docs', 'glafka', 'ethos'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'docs', 'glafka', 'ethos', 'audit.proposed.json'), 'nope');
  assert.deepEqual(readAuditProposals(repoRoot), []);
});
