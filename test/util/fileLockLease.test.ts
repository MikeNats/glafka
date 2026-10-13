import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDir } from '../helpers/tempDir.js';

import {
  withFileLock,
  withFileLockAsync,
  lockBody,
  writeFile,
  DEFAULT_LEASE_MS,
} from '../../src/util/fileOperations.js';

// A waiter used to decide "is the holder really gone?" with a `ps` call, then delete
// the lock. That question can be answered wrongly, and a wrong answer put two writers inside at once. The lease replaces the question with a deadline BOTH sides read. Takeover is a clock comparison the reclaimer cannot get wrong, and — the half that makes it safe — the old holder refuses its own write once that same deadline passes, so a wrongly-timed takeover still cannot produce two writers.

function tmpLock(): string {
  return path.join(makeTempDir('lease'), 'x.lock');
}

test('the lock records a lease deadline', () => {
  const body = JSON.parse(lockBody(1000)) as { leaseUntil?: number };
  assert.equal(typeof body.leaseUntil, 'number');
  assert.ok(
    body.leaseUntil! > Date.now() && body.leaseUntil! <= Date.now() + 1000,
    'the deadline must be in the future and no further out than asked',
  );
});

test('the work under a lock is handed a lease it can check', () => {
  const lockPath = tmpLock();
  const seen = withFileLock(lockPath, (lease) => {
    lease.assertHeld();
    return lease.remainingMs();
  });
  assert.ok(seen > 0 && seen <= DEFAULT_LEASE_MS);
});

test('a holder whose lease ran out REFUSES to write, rather than writing second', () => {
  const lockPath = tmpLock();
  withFileLock(
    lockPath,
    (lease) => {
      // The lease is already spent by the time the work reaches its write.
      assert.throws(() => lease.assertHeld(), /lease ran out/);
      return null;
    },
    // Negative, not 0. Both sides compare with `>`, so at exactly `leaseUntil` the lease still counts as
    // held — consistently, on the holder's side and the reclaimer's, which is why that boundary is safe. But it means a 0ms lease only reads as expired once the clock has moved on, and inside one millisecond it has not. -1 puts the deadline in the past to begin with.
    { leaseMs: -1 },
  );
});

test('a lock whose lease ran out can be taken over, with no ps call and no guessing', () => {
  const lockPath = tmpLock();
  // A live holder — our own pid, so any "is it alive?" check says yes — whose lease has already passed.
  // Before leases, this blocked until the retries ran out, because the owner check could only ever say "still alive".
  fs.writeFileSync(lockPath, lockBody(0));

  const got = withFileLock(lockPath, () => 'taken over', { retries: 2, delayMs: 1 });
  assert.equal(got, 'taken over');
});

test('a lock whose lease is still running is NOT taken over', () => {
  const lockPath = tmpLock();
  fs.writeFileSync(lockPath, lockBody(60_000));

  assert.throws(
    () => withFileLock(lockPath, () => 'should not get here', { retries: 1, delayMs: 1 }),
    /still locked/,
  );
});

test('a lock cleared by hand while we hold it makes our write refuse', () => {
  const lockPath = tmpLock();
  withFileLock(lockPath, (lease) => {
    fs.unlinkSync(lockPath);
    assert.throws(() => lease.assertHeld(), /it is gone/);
    return null;
  });
});

test('a lock replaced by someone else while we hold it makes our write refuse', () => {
  const lockPath = tmpLock();
  withFileLock(lockPath, (lease) => {
    fs.writeFileSync(lockPath, lockBody(60_000));
    assert.throws(() => lease.assertHeld(), /held by someone else/);
    return null;
  });
});

test('writeFile with a spent lease writes NOTHING and leaves no temp file', () => {
  const dir = makeTempDir('lease-w');
  const target = path.join(dir, 'ticket.json');
  fs.writeFileSync(target, 'ORIGINAL');

  const spent = {
    remainingMs: () => -1,
    assertHeld() {
      throw new Error('lease ran out');
    },
  };
  assert.throws(() => writeFile(target, 'OVERWRITTEN', spent), /lease ran out/);

  assert.equal(fs.readFileSync(target, 'utf8'), 'ORIGINAL', 'the file must be untouched');
  assert.deepEqual(
    fs.readdirSync(dir),
    ['ticket.json'],
    'a refused write must not leave a temp file behind',
  );
});

test('a lock written by an older glafka (no lease) still uses the owner check', () => {
  const lockPath = tmpLock();
  // No `leaseUntil`, and a pid nothing can be alive at, so the pre-lease rule is what has to clear it.
  // Without the fallback, an upgrade would leave every such lock stuck for good.
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 0x7fffffff, startedAt: 0, nonce: 'old' }));

  const got = withFileLock(lockPath, () => 'cleared', { retries: 2, delayMs: 1, staleLockMs: 0 });
  assert.equal(got, 'cleared');
});

test('the async variant leases the same way', async () => {
  const lockPath = tmpLock();
  fs.writeFileSync(lockPath, lockBody(0));

  const got = await withFileLockAsync(lockPath, async () => 'taken over', {
    retries: 2,
    delayMs: 1,
  });
  assert.equal(got, 'taken over');

  await withFileLockAsync(lockPath, async (lease) => {
    assert.ok(lease.remainingMs() > 0);
  });
});

test('the lock is released on the way out, so the next writer gets straight in', () => {
  const lockPath = tmpLock();
  withFileLock(lockPath, () => null);
  assert.equal(fs.existsSync(lockPath), false);
  assert.equal(
    withFileLock(lockPath, () => 'second writer'),
    'second writer',
  );
});
