import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CbmError,
  cbmAvailable,
  cbmIndexRepository,
  cbmQuery,
  cbmProject,
} from '../../src/memory/cbm.js';
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

test('cbmAvailable says false on any other failure too: then the markdown map is used', () => {
  const exec: CbmExec = () => {
    const err = new Error('permission denied') as Error & { stderr: string };
    err.stderr = 'permission denied';
    throw err;
  };
  assert.equal(cbmAvailable({ exec }), false);
});

// --- cbmIndexRepository ---

test('cbmIndexRepository runs the real cli form, with a project name of its own', () => {
  const calls: { bin: string; args: string[] }[] = [];
  const exec: CbmExec = (bin, args) => {
    calls.push({ bin, args: [...args] });
    return '{"status":"indexed"}';
  };
  cbmIndexRepository('/my/repo', { exec, home: '/no/such/home' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.bin, 'codebase-memory-mcp');
  const args = calls[0]!.args;
  assert.deepEqual(args.slice(0, 3), ['cli', '--quiet', 'index_repository']);
  assert.equal(args[args.indexOf('--repo-path') + 1], '/my/repo');
  assert.equal(args[args.indexOf('--name') + 1], cbmProject('/my/repo'));
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

test('cbmQuery refreshes the index, then asks about that project by name', () => {
  const calls: string[][] = [];
  const exec: CbmExec = (_bin, args) => {
    calls.push([...args]);
    return args.includes('index_repository') ? '{"status":"indexed"}' : '{"nodes": 42}\n';
  };
  const result = cbmQuery('/my/repo-a', 'get_architecture', { aspects: '["overview"]' }, { exec });
  assert.equal(result, '{"nodes": 42}');
  assert.equal(calls.length, 2);
  assert.ok(calls[0]!.includes('index_repository'));
  const query = calls[1]!;
  assert.deepEqual(query.slice(0, 3), ['cli', '--quiet', 'get_architecture']);
  assert.equal(query[query.indexOf('--project') + 1], cbmProject('/my/repo-a'));
  assert.equal(query[query.indexOf('--aspects') + 1], '["overview"]');
});

test('cbmQuery throws CbmError on non-zero exit', () => {
  const exec: CbmExec = () => {
    const err = new Error('process exited with code 1') as Error & { stderr: string };
    err.stderr = 'unknown tool';
    throw err;
  };
  assert.throws(
    () => cbmQuery('/my/repo-b', 'bad_tool', {}, { exec }),
    (err: unknown) => {
      assert.ok(err instanceof CbmError);
      assert.match(err.message, /unknown tool/);
      return true;
    },
  );
});
