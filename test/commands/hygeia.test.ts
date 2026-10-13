import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hygeia } from '../../src/commands/hygeia/hygeia.js';

// Real npm commands are slow and need internet. We fake `run` instead,
// to check hygeia calls the right, safe commands.
test('hygeia runs npm update then npm audit fix (never --force) in the given cwd', () => {
  const calls: { cmd: string; args: readonly string[]; options: { cwd?: string } }[] = [];

  const result = hygeia({
    cwd: '/some/project',
    // The cwd is a fake, so the manifest check is faked with it. Its real
    // behaviour is covered in uxDefects.test.ts.
    exists: () => true,
    run: (cmd, args, options) => {
      calls.push({ cmd, args, options });
      return 'ok\n';
    },
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, ['update']);
  assert.deepEqual(calls[1].args, ['audit', 'fix']);
  assert.ok(calls.every((c) => c.cmd === 'npm'));
  assert.ok(calls.every((c) => c.options.cwd === '/some/project'));
  assert.ok(!calls[1].args.includes('--force'));

  assert.equal(result.updateLog, 'ok\n');
  assert.equal(result.auditLog, 'ok\n');
});

// npm output can be big and hit Node's 1MB limit.
// Past that limit, Node stops the process and we get an error.
test("hygeia raises maxBuffer past Node's 1MB default on both commands", () => {
  const calls: { maxBuffer?: number }[] = [];
  hygeia({
    cwd: '/some/project',
    exists: () => true,
    run: (cmd, args, options) => {
      calls.push(options);
      return 'ok\n';
    },
  });

  for (const options of calls) {
    assert.ok(
      options.maxBuffer !== undefined && options.maxBuffer > 1024 * 1024,
      `maxBuffer was ${options.maxBuffer}`,
    );
  }
});
