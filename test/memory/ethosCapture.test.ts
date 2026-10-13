import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEthosCaptureSection } from '../../src/memory/ethos.js';
import { DEFAULT_CATEGORIES, flagOf } from '../../src/memory/categories.js';

const CUSTOM = [
  { name: 'DOMAIN', hint: 'our billing rules and invoice lifecycle' },
  { name: 'OPS', hint: 'deploys, runbooks, on-call expectations' },
];

// Text checks use a copy with extra spaces removed. The prompt text wraps
// for readability, and we don't want tests to break on line-wrap changes.
function flat(text: string) {
  return text.replace(/\s+/g, ' ');
}

function section(overrides = {}) {
  return buildEthosCaptureSection({
    ticketId: '2026-08-07-fix-the-login-bypass',
    stage: 'implementing',
    categories: DEFAULT_CATEGORIES,
    ...overrides,
  });
}

// This section teaches a new agent every bucket it can file a rule under.
// A missing category means a file that never gets written to.
test('every configured category gets a runnable command line with the real ticket id', () => {
  const text = section();

  for (const category of DEFAULT_CATEGORIES) {
    assert.match(
      text,
      new RegExp(`glafka psyche 2026-08-07-fix-the-login-bypass ${flagOf(category)}\\b`),
    );
  }
  assert.equal(
    text.match(/glafka psyche 2026-08-07-fix-the-login-bypass --/g)!.length,
    DEFAULT_CATEGORIES.length,
  );
});

// A project's own categories must reach the agent, and glafka's
// default ones must not show up instead.
test("a project's own categories replace the defaults in the prompt", () => {
  const text = section({ categories: CUSTOM });

  assert.match(text, /--domain\s+"<rule>"\s+# our billing rules/);
  assert.match(text, /--ops\s+"<rule>"\s+# deploys, runbooks/);
  assert.doesNotMatch(text, /--security/);
  assert.doesNotMatch(text, /--performance/);
});

test('the advertised flags are exactly the flags psyche accepts for those categories', () => {
  const text = section({ categories: CUSTOM });

  const advertised = [
    ...text.matchAll(/glafka psyche 2026-08-07-fix-the-login-bypass (--[a-z_]+)/g),
  ].map((m) => m[1]);

  assert.deepEqual(advertised.sort(), CUSTOM.map(flagOf).sort());
});

// We want the agent to record things as they happen, not save them
// all for the end, where small remarks get lost.
test('it says record as you go, not at the end', () => {
  const text = section();

  assert.match(text, /Record as you go, not at the end/);
  assert.match(text, /do not wait until implementing is finished/);
});

// What the human says is the most useful input, and also the thing
// an agent is most likely to miss.
test('it tells the agent to record what the human says, with --from you', () => {
  const text = section();

  assert.match(flat(text), /When the human states a preference, makes a decision, or corrects you/);
  assert.match(text, /--from you/);
  assert.match(text, /in their words/);
  assert.match(text, /offhand remarks/);
});

// A missed preference is gone for good. A wrong one only costs one
// keystroke to reject. So the prompt says: when unsure, record it.
test("it errs toward recording the human's words, and toward silence on its own", () => {
  const text = section();

  assert.match(flat(text), /record it anyway and let them turn it down/);
  assert.match(flat(text), /recording nothing is a fine outcome/);
  assert.match(flat(text), /err toward recording/);
});

test('the stage name is woven in, so it reads as part of that work', () => {
  assert.match(section({ stage: 'exploring' }), /until exploring is finished/);
  assert.match(section({ stage: 'this review' }), /until this review is finished/);
});

// Only the final stage should say it is the last one. Otherwise every
// stage would claim to be last and record too much.
test('only the last stage says it is the last one that records', () => {
  const midway = section();
  const last = section({ stage: 'this review', last: true });

  assert.doesNotMatch(midway, /last stage/);
  assert.match(midway, /proposals, not decisions/);

  assert.match(flat(last), /last stage that records anything/);
  assert.match(flat(last), /gets shown to the human next/);
});

test('it states the rules are proposals a human rules on after review', () => {
  assert.match(
    flat(section()),
    /They sit on the ticket until the human rules on them after review/,
  );
});

// A category with no hint would leave the agent guessing what it is for.
// This test checks the hint text really shows up in the prompt.
test("every category's hint reaches the prompt", () => {
  const text = section();

  for (const category of DEFAULT_CATEGORIES) {
    assert.ok(text.includes(category.hint), `hint missing for ${category.name}`);
  }
});

test('no categories at all is an error, not a section with nowhere to file a rule', () => {
  assert.throws(() => section({ categories: [] }), /no categories/);
  assert.throws(() => section({ categories: undefined }), /no categories/);
});
