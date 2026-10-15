import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CbmError, cbmAvailable, cbmIndexRepository, cbmQuery } from '../../src/memory/cbm.js';
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

// --- cbmIndexRepository ---

test('cbmIndexRepository calls the binary with index_repository and the repo root', () => {
  const calls: { bin: string; args: string[] }[] = [];
  const exec: CbmExec = (bin, args) => {
    calls.push({ bin, args: [...args] });
    return '';
  };
  cbmIndexRepository('/my/repo', { exec });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.bin, 'codebase-memory-mcp');
  assert.ok(calls[0]!.args.includes('index_repository'));
  assert.ok(calls[0]!.args.includes('/my/repo'));
});

test('cbmIndexRepository throws CbmError on non-zero exit', () => {
  const exec: CbmExec = () => {
    const err = new Error('process exited with code 1') as Error & { stderr: string };
    err.stderr = 'disk full';
    throw err;
  };
  assert.throws(
    () => cbmIndexRepository('/my/repo', { exec }),
    (err: unknown) => {
      assert.ok(err instanceof CbmError);
      assert.match(err.message, /disk full/);
      return true;
    },
  );
});

// --- cbmQuery ---

test('cbmQuery returns stdout and passes tool name and args to the binary', () => {
  const calls: { bin: string; args: string[] }[] = [];
  const exec: CbmExec = (bin, args) => {
    calls.push({ bin, args: [...args] });
    return '{"nodes": 42}\n';
  };
  const result = cbmQuery('/my/repo', 'get_architecture', { detail_level: 'high' }, { exec });
  assert.equal(result, '{"nodes": 42}');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.bin, 'codebase-memory-mcp');
  assert.ok(calls[0]!.args.includes('get_architecture'));
  assert.ok(calls[0]!.args.includes('/my/repo'));
  assert.ok(calls[0]!.args.includes('--detail_level'));
  assert.ok(calls[0]!.args.includes('high'));
});

test('cbmQuery throws CbmError on non-zero exit', () => {
  const exec: CbmExec = () => {
    const err = new Error('process exited with code 1') as Error & { stderr: string };
    err.stderr = 'unknown tool';
    throw err;
  };
  assert.throws(
    () => cbmQuery('/my/repo', 'bad_tool', {}, { exec }),
    (err: unknown) => {
      assert.ok(err instanceof CbmError);
      assert.match(err.message, /unknown tool/);
      return true;
    },
  );
});
