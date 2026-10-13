import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDir } from '../helpers/tempDir.js';
import { appendDecision, readDecisions, DECISION_SOURCE } from '../../src/ticket/decisions.js';

const ID = '2026-08-14-a-ticket';

test('the first write creates both sections, person first', () => {
  const stateDir = makeTempDir('state');
  appendDecision(stateDir, ID, { source: DECISION_SOURCE.PERSON, text: 'no lat/lon input' });

  const text = readDecisions(stateDir, ID)!;
  assert.ok(text.indexOf('## Person decisions') < text.indexOf('## Coder decisions'));
  assert.match(text, /## Person decisions\n\n- no lat\/lon input\n/);
});

test('a coder line lands under the coder heading, not the person one', () => {
  const stateDir = makeTempDir('state');
  appendDecision(stateDir, ID, { source: DECISION_SOURCE.PERSON, text: 'no lat/lon input' });
  appendDecision(stateDir, ID, { source: DECISION_SOURCE.CODER, text: 'chose Map over object' });

  const text = readDecisions(stateDir, ID)!;
  const personBlock = text.slice(
    text.indexOf('## Person decisions'),
    text.indexOf('## Coder decisions'),
  );
  assert.match(personBlock, /no lat\/lon input/);
  assert.doesNotMatch(personBlock, /chose Map over object/);
  assert.match(text.slice(text.indexOf('## Coder decisions')), /chose Map over object/);
});

test('lines keep the order they were written in', () => {
  const stateDir = makeTempDir('state');
  appendDecision(stateDir, ID, { source: DECISION_SOURCE.PERSON, text: 'first' });
  appendDecision(stateDir, ID, { source: DECISION_SOURCE.PERSON, text: 'second' });

  const text = readDecisions(stateDir, ID)!;
  assert.ok(text.indexOf('- first') < text.indexOf('- second'));
});

test('readDecisions is null when nothing was ever written', () => {
  const stateDir = makeTempDir('state');
  assert.equal(readDecisions(stateDir, ID), null);
});

test('empty text and a multi-line decision are both refused', () => {
  const stateDir = makeTempDir('state');
  assert.throws(
    () => appendDecision(stateDir, ID, { source: DECISION_SOURCE.PERSON, text: '   ' }),
    /needs some text/,
  );
  assert.throws(
    () => appendDecision(stateDir, ID, { source: DECISION_SOURCE.PERSON, text: 'one\ntwo' }),
    /one line/,
  );
});
