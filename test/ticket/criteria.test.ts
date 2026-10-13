import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCriteria,
  strayCriteria,
  assertNoDuplicateCriteria,
} from '../../src/ticket/criteria.js';

const SPEC = `# Export — spec

## Why

because

## Acceptance criteria

- AC-1: empty report → GET /export → 200, header only
- AC-2: no session → GET /export → 401

## Notes

- AC-9: not in the section, ignored
`;

test('a spec with no AC section has no criteria', () => {
  assert.deepEqual(parseCriteria('# T\n\n## Why\n\nx\n'), {
    criteria: [],
    badLines: [],
    duplicates: [],
  });
});

test('reads each AC line and stops at the next heading', () => {
  const { criteria, badLines, duplicates } = parseCriteria(SPEC);
  assert.deepEqual(criteria, [
    { id: 'AC-1', text: 'empty report → GET /export → 200, header only' },
    { id: 'AC-2', text: 'no session → GET /export → 401' },
  ]);
  assert.deepEqual(badLines, []);
  assert.deepEqual(duplicates, []);
});

test('a line in the section that is not an AC line is a bad line', () => {
  const { criteria, badLines } = parseCriteria(
    '## Acceptance criteria\n\n- check it works\n- AC-1: a → b → c\n',
  );
  assert.deepEqual(badLines, ['- check it works']);
  assert.equal(criteria.length, 1);
});

test('the same id twice is a duplicate', () => {
  const { duplicates } = parseCriteria(
    '## Acceptance criteria\n- AC-1: a → b → c\n- AC-1: d → e → f\n',
  );
  assert.deepEqual(duplicates, ['AC-1']);
});

test('a fenced template above the real section is ignored', () => {
  const spec = [
    '# T',
    '',
    '```markdown',
    '## Acceptance criteria',
    '',
    '- AC-1: <start state> → <action> → <what you see>',
    '```',
    '',
    '## Acceptance criteria',
    '',
    '- AC-1: empty report → GET /export → 200',
    '',
  ].join('\n');
  assert.deepEqual(parseCriteria(spec), {
    criteria: [{ id: 'AC-1', text: 'empty report → GET /export → 200' }],
    badLines: [],
    duplicates: [],
  });
});

test('a fenced block in the section is skipped, and a "# x" inside it does not end the section', () => {
  const spec = [
    '## Acceptance criteria',
    '',
    '- AC-1: a → b → c',
    '~~~sh',
    '# x',
    'curl -s /export',
    '~~~',
    '- AC-2: d → e → f',
    '',
  ].join('\n');
  const { criteria, badLines } = parseCriteria(spec);
  assert.deepEqual(
    criteria.map((c) => c.id),
    ['AC-1', 'AC-2'],
  );
  assert.deepEqual(badLines, []);
});

// Common ways a person writes the heading. Each one used to turn the AC gate off without a word.
for (const heading of [
  '## Acceptance Criteria (AC)',
  '### Acceptance criteria',
  '## 4. Acceptance criteria',
  '## Acceptance criteria:',
  '### 2. ACCEPTANCE CRITERIA (AC):',
]) {
  test(`the heading "${heading}" starts the section`, () => {
    const { criteria } = parseCriteria(`# T\n\n${heading}\n\n- AC-1: a → b → c\n`);
    assert.deepEqual(
      criteria.map((c) => c.id),
      ['AC-1'],
    );
  });
}

test('a level 3 section ends at the next level 3 heading', () => {
  const spec = '### Acceptance criteria\n- AC-1: a → b → c\n### Notes\n- AC-9: not a criterion\n';
  const { criteria, badLines } = parseCriteria(spec);
  assert.deepEqual(
    criteria.map((c) => c.id),
    ['AC-1'],
  );
  assert.deepEqual(badLines, []);
});

test('only a heading names the section, not a line that mentions it', () => {
  assert.deepEqual(parseCriteria('# T\n\nAcceptance criteria\n- AC-1: a\n').criteria, []);
  assert.deepEqual(parseCriteria('#### Acceptance criteria\n- AC-1: a\n').criteria, []);
});

test('strayCriteria finds AC lines that sit under no AC heading', () => {
  assert.deepEqual(strayCriteria('# T\n\n## Checks\n\n- AC-1: a → b → c\n- AC-2: d\n'), [
    '- AC-1: a → b → c',
    '- AC-2: d',
  ]);
  assert.deepEqual(strayCriteria('## Acceptance criteria\n- AC-1: a → b → c\n'), []);
  assert.deepEqual(strayCriteria('```\n- AC-1: an example\n```\n'), []);
});

// A fence closes only on its own marker. The other marker inside it is just text.
test('a ``` fence holding a ~~~ line stays open, so its "## " line ends nothing', () => {
  const spec = [
    '## Acceptance criteria',
    '- AC-1: a → b → c',
    '```md',
    '~~~',
    '## Not a heading',
    '- AC-8: an example',
    '```',
    '- AC-2: d → e → f',
  ].join('\n');
  assert.deepEqual(
    parseCriteria(spec).criteria.map((c) => c.id),
    ['AC-1', 'AC-2'],
  );
});

test('a ~~~ fence holding a ``` line stays open too', () => {
  const spec = [
    '## Acceptance criteria',
    '- AC-1: a → b → c',
    '~~~',
    '```',
    '## Not a heading',
    '- AC-8: an example',
    '~~~',
    '- AC-2: d → e → f',
  ].join('\n');
  assert.deepEqual(
    parseCriteria(spec).criteria.map((c) => c.id),
    ['AC-1', 'AC-2'],
  );
});

// I6: CommonMark fences. A fence closes on the same character, a run at least as long,
// with nothing after it. A ``` opening line may hold no other backtick.
test('a ```` fence holding a ``` line does not close early', () => {
  const spec = [
    '## Acceptance criteria',
    '- AC-1: a → b → c',
    '````md',
    '```',
    '## Not a heading',
    '```',
    '- AC-8: example',
    '````',
    '- AC-2: d → e → f',
  ].join('\n');
  assert.deepEqual(parseCriteria(spec), {
    criteria: [
      { id: 'AC-1', text: 'a → b → c' },
      { id: 'AC-2', text: 'd → e → f' },
    ],
    badLines: [],
    duplicates: [],
  });
});

test('a ```bash line inside an open fence does not close it', () => {
  const spec = ['# t', '```', 'echo hi', '```bash', 'more', '```', '## Acceptance criteria'];
  const parsed = parseCriteria([...spec, '- AC-1: a → b → c'].join('\n'));
  assert.deepEqual(
    parsed.criteria.map((c) => c.id),
    ['AC-1'],
  );
});

test('a line that starts with inline ```code``` opens no fence', () => {
  const spec = [
    '# t',
    '## 1. Change',
    '```npm test``` must stay green.',
    '',
    '## Acceptance criteria',
    '- AC-1: a → b → c',
    '- AC-2: d → e → f',
  ].join('\n');
  assert.deepEqual(
    parseCriteria(spec).criteria.map((c) => c.id),
    ['AC-1', 'AC-2'],
  );
});

test('a fence closes on a longer run of its own character, not a shorter one', () => {
  const longer = ['````', 'x', '`````', '## Acceptance criteria', '- AC-1: a → b → c'];
  assert.deepEqual(
    parseCriteria(longer.join('\n')).criteria.map((c) => c.id),
    ['AC-1'],
  );
  const shorter = ['````', 'x', '```', '## Acceptance criteria', '- AC-1: a → b → c', '````'];
  assert.deepEqual(parseCriteria(shorter.join('\n')).criteria, []);
});

test('a ~~~ fence may carry an info string with a backtick', () => {
  const spec = ['~~~ `x`', '## Acceptance criteria', '- AC-9: in the fence', '~~~'];
  const parsed = parseCriteria([...spec, '## Acceptance criteria', '- AC-1: a'].join('\n'));
  assert.deepEqual(
    parsed.criteria.map((c) => c.id),
    ['AC-1'],
  );
});

// I6: every "- AC-n:" line the parser did not take is named, not only when there is no heading.
test('strayCriteria names AC lines after a sub-heading that ends the section', () => {
  const spec = '### Acceptance criteria\n- AC-1: a → b → c\n### Error cases\n- AC-2: x → y → z\n';
  assert.deepEqual(strayCriteria(spec), ['- AC-2: x → y → z']);
});

test('strayCriteria names AC lines in a second AC section', () => {
  const spec = [
    '## Acceptance criteria',
    '- AC-1: a → b → c',
    '## Out of scope',
    '- nothing',
    '## Acceptance criteria',
    '- AC-2: x → y → z',
  ].join('\n');
  assert.deepEqual(strayCriteria(spec), ['- AC-2: x → y → z']);
});

test('strayCriteria names an AC line in a later section, but not one in a fence', () => {
  assert.deepEqual(strayCriteria(SPEC), ['- AC-9: not in the section, ignored']);
  const fenced = '## Acceptance criteria\n- AC-1: a\n## Notes\n```\n- AC-7: example\n```\n';
  assert.deepEqual(strayCriteria(fenced), []);
});

test('assertNoDuplicateCriteria refuses one id twice, and names it', () => {
  assert.throws(
    () => assertNoDuplicateCriteria('## Acceptance criteria\n- AC-3: a\n- AC-3: b\n', 'the idea'),
    /AC-3 appears twice in the idea/,
  );
  assertNoDuplicateCriteria('## Acceptance criteria\n- AC-1: a\n- AC-2: b\n', 'the idea');
});
