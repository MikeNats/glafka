import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPidAlive, processStartTimeMs, sameProcessStart } from '../../src/util/process.js';

test('isPidAlive is true for the current process and false for one that does not exist', () => {
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(999999), false);
});

test('processStartTimeMs reads a real start time for the current process', () => {
  const start = processStartTimeMs(process.pid);
  assert.notEqual(start, null);
  // Sane bounds: not in the future, and not implausibly old (this test
  // process did not exist an hour ago).
  assert.ok(start! <= Date.now());
  assert.ok(start! > Date.now() - 60 * 60 * 1000);
});

test('processStartTimeMs is null for a pid that does not exist', () => {
  assert.equal(processStartTimeMs(999999), null);
});

// This comparison is what tells a still-ours pid apart from one the OS has since
// handed to a different, unrelated process: the proof captured at spawn time must still match a fresh read, within ps's own resolution and reading slack, but not across a real gap.
test('sameProcessStart tolerates ps-reading slack but not a real gap', () => {
  const now = Date.now();
  assert.equal(sameProcessStart(now, now + 2000), true);
  assert.equal(sameProcessStart(now, now + 30000), false);
});
