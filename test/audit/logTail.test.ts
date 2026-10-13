import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDir } from '../helpers/tempDir.js';
import { logTail } from '../../src/audit/logTail.js';

test('a short log is returned whole', () => {
  const dir = makeTempDir('tail');
  const file = path.join(dir, 'log');
  fs.writeFileSync(file, 'hello\n');

  assert.equal(logTail(file), 'hello\n');
});

// A coder log can be megabytes. The usage block is at the end.
test('a long log gives back only its tail', () => {
  const dir = makeTempDir('tail');
  const file = path.join(dir, 'log');
  fs.writeFileSync(file, `${'x'.repeat(5000)}THE-END`);

  const tail = logTail(file, 100);
  assert.equal(tail!.length, 100);
  assert.match(tail!, /THE-END$/);
});

// A run that never started has no log. That is not an error.
test('a missing log reads as null, not as empty', () => {
  assert.equal(logTail(path.join(makeTempDir('tail'), 'nope')), null);
});
