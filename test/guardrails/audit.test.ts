import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { record, read } from '../../installKit/guardrails/audit.js';
import { loadLevel } from '../../installKit/guardrails/resolve.js';
import type { Policy } from '../../installKit/guardrails/types/policy.js';
import { makeTempDir } from '../helpers/tempDir.js';

// --------------------------------------------------------------------------- Bug fix: the audit log
// used to grow forever, with no size limit and no cleanup. These tests check the log is now capped and rolled over. ---------------------------------------------------------------------------

function auditPolicy(overrides: Partial<Policy['audit']> = {}): Policy {
  const base = loadLevel(2);
  return { ...base, audit: { ...base.audit, ...overrides } };
}

function recordMany(policy: Policy, stateDir: string, count: number): string {
  let filePath = '';
  for (let i = 0; i < count; i += 1) {
    filePath =
      record(policy, {
        stateDir,
        ticketId: '2026-08-02-cage-the-coder',
        action: { op: 'read', filePath: `/repo/file-${i}.ts` },
        decision: { allow: true, layer: null, reason: 'inside the worktree' },
        sourceEnv: {},
      }) ?? filePath;
  }
  return filePath;
}

test('the audit log is rolled instead of growing without bound', () => {
  const stateDir = makeTempDir('audit');
  const policy = auditPolicy({ maxBytes: 4096 });

  const filePath = recordMany(policy, stateDir, 500);

  assert.ok(fs.statSync(filePath).size <= 4096 * 2, 'the live file stays near its cap');
  assert.equal(fs.existsSync(`${filePath}.1`), true, 'and the previous generation is kept');
});

test('only one rolled generation is kept, so the cap really is a cap', () => {
  const stateDir = makeTempDir('audit');
  const policy = auditPolicy({ maxBytes: 2048 });

  const filePath = recordMany(policy, stateDir, 2000);

  assert.equal(fs.existsSync(`${filePath}.2`), false);
  const total = fs.statSync(filePath).size + fs.statSync(`${filePath}.1`).size;
  assert.ok(total < 2048 * 4, `the whole log is bounded (${total} bytes)`);
});

test('the most recent entries survive a roll', () => {
  const stateDir = makeTempDir('audit');
  const policy = auditPolicy({ maxBytes: 2048 });

  recordMany(policy, stateDir, 400);
  const entries = read(policy, { stateDir, ticketId: '2026-08-02-cage-the-coder' });

  assert.ok(entries.length > 0);
  assert.match(entries[entries.length - 1].action.filePath as string, /file-399\.ts$/);
});

test('a small log is not rolled at all', () => {
  const stateDir = makeTempDir('audit');
  const policy = auditPolicy();

  const filePath = recordMany(policy, stateDir, 5);

  assert.equal(fs.existsSync(`${filePath}.1`), false);
  assert.equal(read(policy, { stateDir, ticketId: '2026-08-02-cage-the-coder' }).length, 5);
});
