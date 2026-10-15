import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CbmError, cbmAvailable } from '../../src/memory/cbm.js';
import type { CbmExec } from '../../src/memory/cbm.js';

test('CbmError has the right name and is an Error', () => {
  const err = new CbmError('something broke');
  assert.equal(err.name, 'CbmError');
  assert.ok(err instanceof Error);
  assert.equal(err.message, 'something broke');
});

// --- cbmAvailable ---

test('cbmAvailable returns true when the binary is found', () => {
  const exec: CbmExec = () => '';
  assert.equal(cbmAvailable({ exec }), true);
});

test('cbmAvailable returns false when the binary is not on PATH', () => {
  const exec: CbmExec = () => {
    const err = new Error('spawn codebase-memory-mcp ENOENT') as Error & { code: string };
    err.code = 'ENOENT';
    throw err;
  };
  assert.equal(cbmAvailable({ exec }), false);
});

test('cbmAvailable throws CbmError on unexpected failures', () => {
  const exec: CbmExec = () => {
    const err = new Error('permission denied') as Error & { stderr: string };
    err.stderr = 'permission denied';
    throw err;
  };
  assert.throws(
    () => cbmAvailable({ exec }),
    (err: unknown) => {
      assert.ok(err instanceof CbmError);
      assert.match(err.message, /permission denied/);
      return true;
    },
  );
});
