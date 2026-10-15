import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CbmError } from '../../src/memory/cbm.js';

test('CbmError has the right name and is an Error', () => {
  const err = new CbmError('something broke');
  assert.equal(err.name, 'CbmError');
  assert.ok(err instanceof Error);
  assert.equal(err.message, 'something broke');
});
