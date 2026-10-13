import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { makeTempDir } from '../helpers/tempDir.js';
import {
  formatFileTree,
  withFileLock,
  ownerIsGone,
  lockBody,
} from '../../src/util/fileOperations.js';
import { processStartTimeMs } from '../../src/util/process.js';
import { listProjectFiles } from '../../src/util/git.js';
import { NODE_TSX_ARGS } from '../helpers/tsxLoader.js';

// A real git repo, since file listing uses git.
// The .gitignore here matches a real project setup.
function tempRepo() {
  const root = makeTempDir('tree');
  execFileSync('git', ['init', '-q'], { cwd: root });

  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\ndist/\n.glafka/\n.worktrees/\n');

  fs.mkdirSync(path.join(root, 'src', 'commands'), { recursive: true });
  fs.writeFileSync(path.join(root, 'README.md'), 'hi\n');
  fs.writeFileSync(path.join(root, 'src', 'index.js'), 'export {}\n');
  fs.writeFileSync(path.join(root, 'src', 'commands', 'foo.js'), 'export {}\n');

  // These files should not show up in the list.
  fs.mkdirSync(path.join(root, 'node_modules', 'somepkg'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'somepkg', 'index.js'), '\n');
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dist', 'bundle.js'), '\n');
  fs.mkdirSync(path.join(root, '.worktrees', '2026-08-07-add-search-filters', 'src'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(root, '.worktrees', '2026-08-07-add-search-filters', 'src', 'index.js'),
    '\n',
  );

  return root;
}

test('listProjectFiles reports tracked and new files, nested paths included', () => {
  const root = tempRepo();

  const paths = listProjectFiles(root);

  assert.ok(paths.includes('README.md'));
  assert.ok(paths.includes('src/index.js'));
  assert.ok(paths.includes('src/commands/foo.js'));
});

test('listProjectFiles reports a file that has never been added to the index', () => {
  const root = tempRepo();
  execFileSync('git', ['add', 'README.md'], { cwd: root });

  const paths = listProjectFiles(root);

  // One file is staged, one is not. Both should show up.
  assert.ok(paths.includes('README.md'));
  assert.ok(paths.includes('src/index.js'));
});

test('listProjectFiles honours .gitignore, so build output stays out of the prompt', () => {
  const root = tempRepo();

  const paths = listProjectFiles(root);

  assert.ok(!paths.some((p) => p.startsWith('node_modules/')));
  assert.ok(!paths.some((p) => p.startsWith('dist/')));
});

test('listProjectFiles never walks .git', () => {
  const root = tempRepo();

  const paths = listProjectFiles(root);

  assert.ok(!paths.some((p) => p.startsWith('.git/')));
});

// This checks a bug fix: extra worktree copies should not show up.
test("listProjectFiles excludes other tickets' worktrees", () => {
  const root = tempRepo();

  const paths = listProjectFiles(root);

  assert.ok(!paths.some((p) => p.startsWith('.worktrees/')));
});

test('formatFileTree renders a readable indented listing', () => {
  const rendered = formatFileTree(['README.md', 'src/index.js', 'src/commands/foo.js']);

  assert.equal(
    rendered,
    ['README.md', 'src/', '  commands/', '    foo.js', '  index.js'].join('\n'),
  );
});

test('formatFileTree sorts entries and nests directories under their parent', () => {
  const rendered = formatFileTree(['b/two.js', 'a.md', 'b/one.js']);

  assert.equal(rendered, ['a.md', 'b/', '  one.js', '  two.js'].join('\n'));
});

test('formatFileTree renders an empty project as an empty string', () => {
  assert.equal(formatFileTree([]), '');
});

// --------------------------------------------------------------------------- Tests for withFileLock,
// which keeps two processes from clashing. ---------------------------------------------------------------------------

function tempLockPath() {
  return path.join(makeTempDir('lock'), 't.json.lock');
}

test('withFileLock removes the lock file once fn returns', () => {
  const lockPath = tempLockPath();
  const result = withFileLock(lockPath, () => {
    assert.ok(fs.existsSync(lockPath), 'lock file should exist while fn runs');
    return 42;
  });
  assert.equal(result, 42);
  assert.equal(fs.existsSync(lockPath), false);
});

test('withFileLock still removes the lock file when fn throws', () => {
  const lockPath = tempLockPath();
  assert.throws(
    () =>
      withFileLock(lockPath, () => {
        throw new Error('boom');
      }),
    /boom/,
  );
  assert.equal(fs.existsSync(lockPath), false, 'a thrown fn must not leak the lock');
});

test('withFileLock gives up and throws EEXIST once retries are exhausted', () => {
  const lockPath = tempLockPath();
  fs.writeFileSync(lockPath, ''); // a lock we can't read is treated as still active
  assert.throws(
    () => withFileLock(lockPath, () => {}, { retries: 3, delayMs: 5 }),
    (err: NodeJS.ErrnoException) =>
      err.code === 'EEXIST' &&
      /still locked after 3 retries/.test(err.message) &&
      err.message.includes(lockPath),
  );
});

// --------------------------------------------------------------------------- If a process is killed
// while holding the lock, the lock file used to stay forever. These tests check that old locks get cleaned up. ---------------------------------------------------------------------------

test('withFileLock reaps a lock whose holder process is dead, and still runs fn', () => {
  const lockPath = tempLockPath();
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, startedAt: Date.now() })); // this pid does not exist on this machine
  const result = withFileLock(lockPath, () => 42, { retries: 3, delayMs: 5 });
  assert.equal(result, 42);
  assert.equal(fs.existsSync(lockPath), false);
});

// Only for locks from an older glafka, which carry no startProof. A lock
// written today keeps one, and the test below shows age stops mattering.
test('withFileLock still reaps a startProof-less lock that outlived staleLockMs', () => {
  const lockPath = tempLockPath();
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: process.pid, startedAt: Date.now() - 10_000 }), // this is the current process, which is alive
  );
  const result = withFileLock(lockPath, () => 'ok', { retries: 3, delayMs: 5, staleLockMs: 1000 });
  assert.equal(result, 'ok');
});

// The steal that used to happen here put two writers in the same critical
// section — the one thing the lock exists to stop.
test('withFileLock never steals from a live owner, however old the lock is', () => {
  const lockPath = tempLockPath();
  fs.writeFileSync(
    lockPath,
    JSON.stringify({
      pid: process.pid,
      startedAt: Date.now() - 60 * 60 * 1000,
      startProof: processStartTimeMs(process.pid),
    }),
  );
  assert.throws(
    () => withFileLock(lockPath, () => 'stolen', { retries: 2, delayMs: 5, staleLockMs: 1000 }),
    (err: NodeJS.ErrnoException) => err.code === 'EEXIST',
  );
  assert.ok(fs.existsSync(lockPath), 'a live owner must keep its lock');
  fs.unlinkSync(lockPath);
});

// A pid alone is not identity. The number gets handed out again, and the
// process holding it now never took our lock.
test('ownerIsGone reports a recycled pid as gone, and the real owner as present', () => {
  const proof = processStartTimeMs(process.pid);
  assert.equal(ownerIsGone({ pid: process.pid, startedAt: Date.now(), startProof: proof }), false);
  assert.equal(
    ownerIsGone({ pid: process.pid, startedAt: Date.now(), startProof: proof! - 600_000 }),
    true,
  );
  assert.equal(ownerIsGone({ pid: 999999, startedAt: Date.now(), startProof: proof }), true);
});

// Same body twice would let one release delete the other's lock.
test('lockBody is different every time it is called', () => {
  assert.notEqual(lockBody(), lockBody());
});

test('withFileLock does not reap a live, recent lock — only a dead-or-expired one', () => {
  const lockPath = tempLockPath();
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  assert.throws(
    () => withFileLock(lockPath, () => {}, { retries: 2, delayMs: 5, staleLockMs: 60_000 }),
    (err: NodeJS.ErrnoException) => err.code === 'EEXIST',
  );
});

test('withFileLock writes { pid, startedAt } into the lock file while held', () => {
  const lockPath = tempLockPath();
  withFileLock(lockPath, () => {
    const { pid, startedAt } = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.equal(pid, process.pid);
    assert.equal(typeof startedAt, 'number');
  });
});

// Two real processes update the same file at once.
// Without the lock, one update would get lost.
test('withFileLock serializes a read-modify-write race across two real processes', async () => {
  const dir = makeTempDir('lock-race');
  const counterPath = path.join(dir, 'counter.json');
  const lockPath = `${counterPath}.lock`;
  fs.writeFileSync(counterPath, '0');

  const workerPath = path.join(dir, 'worker.mjs');
  fs.writeFileSync(
    workerPath,
    `
import { withFileLock } from ${JSON.stringify(path.resolve('src/util/fileOperations.js'))};
import fs from "node:fs";
withFileLock(${JSON.stringify(lockPath)}, () => {
  const n = Number(fs.readFileSync(${JSON.stringify(counterPath)}, "utf8"));
  // A short pause makes the race happen every time, not just sometimes.
  const start = Date.now();
  while (Date.now() - start < 20) {}
  fs.writeFileSync(${JSON.stringify(counterPath)}, String(n + 1));
});
`,
  );

  const N = 6;
  await Promise.all(
    Array.from(
      { length: N },
      () =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(process.execPath, [...NODE_TSX_ARGS, workerPath]);
          let stderr = '';
          child.stderr.on('data', (d) => (stderr += d));
          child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(stderr))));
        }),
    ),
  );

  assert.equal(Number(fs.readFileSync(counterPath, 'utf8')), N);
});

// If another process deletes our lock while we work,
// the result should still come back, not get lost.
test('releasing a lock that was already reaped does not lose the result', () => {
  const dir = makeTempDir('lock');
  const lockPath = path.join(dir, 'x.lock');

  const result = withFileLock(lockPath, () => {
    // Someone else deleted the lock while we worked.
    fs.unlinkSync(lockPath);
    return 'the work succeeded';
  });

  assert.equal(result, 'the work succeeded');
});

// If our lock is gone, we should not delete
// a new lock that someone else made.
test('a lock taken by someone else is not deleted on our way out', () => {
  const dir = makeTempDir('lock');
  const lockPath = path.join(dir, 'x.lock');

  withFileLock(lockPath, () => {
    fs.unlinkSync(lockPath);
    // Another process takes the lock we lost.
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, startedAt: Date.now() }));
  });

  assert.equal(fs.existsSync(lockPath), true, "someone else's lock must survive");
  assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid, 999999);
});

test('our own lock is still released normally', () => {
  const dir = makeTempDir('lock');
  const lockPath = path.join(dir, 'x.lock');

  withFileLock(lockPath, () => 'done');
  assert.equal(fs.existsSync(lockPath), false);
});

// Stealing has to stay possible (or a dead holder wedges
// the ticket for good) while a LIVE holder is never touched.
test('a dead holder is reclaimed, a live one with a real proof is not', () => {
  const dir = makeTempDir('lock29');
  const lockPath = path.join(dir, 'x.lock');

  // Dead pid: must be reclaimed, or the ticket is wedged for good again.
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, startedAt: 1, startProof: 1 }));
  let entered = false;
  withFileLock(lockPath, () => {
    entered = true;
  });
  assert.equal(entered, true, 'a dead holder must be reclaimable');

  // Live pid with a proof the OS still agrees with: never stealable, however old.
  fs.writeFileSync(
    lockPath,
    JSON.stringify({
      pid: process.pid,
      startedAt: 1,
      startProof: processStartTimeMs(process.pid),
    }),
  );
  assert.throws(
    () => withFileLock(lockPath, () => {}, { retries: 0, delayMs: 1, staleLockMs: 0 }),
    /still locked/,
    'a live holder must survive any staleness rule',
  );

  fs.rmSync(dir, { recursive: true, force: true });
});

// `wx` made the CREATE exclusive; the content was a second syscall, so a crash
// between them left a zero-byte lock nothing could judge, and ownerIsGone answered "alive" for it forever.
test('an unreadable lock names nobody, so age is allowed to settle it', () => {
  const dir = makeTempDir('lock30b');
  const lockPath = path.join(dir, 'x.lock');
  fs.writeFileSync(lockPath, '');
  let entered = false;
  // staleLockMs 0: the empty lock names no live process, so nothing is guessed
  // about an owner -- there is none to guess about.
  withFileLock(
    lockPath,
    () => {
      entered = true;
    },
    { staleLockMs: 0 },
  );
  assert.equal(entered, true, 'a lock that names nobody must not wedge the ticket');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a lock is published complete or not at all', () => {
  const dir = makeTempDir('lock30');
  const lockPath = path.join(dir, 'x.lock');
  withFileLock(lockPath, () => {
    const body = fs.readFileSync(lockPath, 'utf8');
    // Whatever is on disk while we hold it must already parse.
    const parsed = JSON.parse(body);
    assert.equal(parsed.pid, process.pid);
  });
  // And no staging file is left behind.
  assert.deepEqual(
    fs.readdirSync(dir).filter((n) => n.includes('.tmp-')),
    [],
  );
  fs.rmSync(dir, { recursive: true, force: true });
});
