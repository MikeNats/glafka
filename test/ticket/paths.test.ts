import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from '../helpers/tempDir.js';
import {
  ticketsDir,
  closedTicketsDir,
  ticketFiles,
  ticketLockPath,
  listFileLocks,
  listProvisioning,
  writeProvisioningLock,
  isStaleFileLock,
  runFiles,
  worktreesRoot,
  worktreePath,
  assertIsTicketWorktree,
  assertUnderWorktreesRoot,
  specPath,
  planPath,
  auditPath,
  ticketIdTaken,
} from '../../src/ticket/paths.js';

const ID = '2026-08-07-fix-the-login-bypass';
// Bad ticket ids: some try to escape the folder, others are just not valid ids.
// t-57faff1d is the format this replaced, so it belongs here now.
const BAD_IDS = [
  '../../etc/passwd',
  '..',
  '/etc/passwd',
  't-57faff1d', // invalid: the format this replaced
  't-ZZZZZZZZ', // invalid: never was an id
  `${ID}.md`,
  `${ID}/../..`,
  '2026-08-07-UPPER',
  '2026-8-7-short-date',
  'no-date-at-all',
  '2026-08-07-',
  '',
];

function tempDir() {
  return makeTempDir('paths');
}

test("a ticket's files all sit in one folder named for the id", () => {
  const stateDir = tempDir();

  const { dir, ticketFile, stagesFile, recordFile } = ticketFiles(ticketsDir(stateDir), ID);

  assert.equal(dir, path.join(stateDir, 'tickets', ID));
  assert.equal(ticketFile, path.join(dir, 'ticket.json'));
  assert.equal(stagesFile, path.join(dir, 'stages'));
  assert.equal(recordFile, path.join(dir, 'record.jsonl'));
});

test('closed tickets resolve under tickets/closed', () => {
  const stateDir = tempDir();

  const { ticketFile } = ticketFiles(closedTicketsDir(stateDir), ID);

  assert.equal(ticketFile, path.join(stateDir, 'tickets', 'closed', ID, 'ticket.json'));
});

// The lock is a SIBLING of the folder, never inside it. Inside, archiving
// would rename it while a holder still owned the old path.
test("the write lock sits beside a ticket's folder, not inside it", () => {
  const stateDir = tempDir();

  const lockPath = ticketLockPath(stateDir, ID);

  assert.equal(lockPath, path.join(stateDir, 'tickets', `${ID}.lock`));
  assert.equal(path.dirname(lockPath), ticketsDir(stateDir));
  assert.notEqual(path.dirname(lockPath), ticketFiles(ticketsDir(stateDir), ID).dir);
});

test("a run's files all sit in one directory named for the id and role", () => {
  const stateDir = tempDir();

  const files = runFiles(stateDir, ID, 'coder');

  assert.equal(files.dir, path.join(stateDir, 'tickets', ID, 'runs', 'coder'));
  const keys = [
    'pidPath',
    'logPath',
    'exitCodePath',
    'promptPath',
    'agentPath',
    'startedAtPath',
  ] as const;
  for (const key of keys) {
    assert.equal(path.dirname(files[key]), files.dir, key);
  }
});

// A coder run and a reviewer run must use separate folders.
test('different roles for the same ticket get different directories', () => {
  const stateDir = tempDir();

  assert.equal(
    runFiles(stateDir, ID).dir,
    path.join(stateDir, 'tickets', ID, 'runs', 'coder'),
    'defaults to coder',
  );
  assert.equal(
    runFiles(stateDir, ID, 'reviewer').dir,
    path.join(stateDir, 'tickets', ID, 'runs', 'reviewer'),
  );
});

test('a worktree is a top-level directory, not nested under .glafka', () => {
  const repoRoot = tempDir();

  assert.equal(worktreePath(repoRoot, ID), path.join(repoRoot, '.worktrees', ID));
  assert.equal(worktreesRoot(repoRoot), path.join(repoRoot, '.worktrees'));
});

test('a ticket is one folder in the docs tree too, git-tracked and permanent', () => {
  const repoRoot = tempDir();

  assert.equal(specPath(repoRoot, ID), path.join(repoRoot, 'docs/glafka/tickets', ID, 'spec.md'));
  assert.equal(planPath(repoRoot, ID), path.join(repoRoot, 'docs/glafka/tickets', ID, 'plan.md'));
  assert.equal(
    auditPath(repoRoot, ID),
    path.join(repoRoot, 'docs/glafka/tickets', ID, 'audit.jsonl'),
  );
  // Same folder for all three, so the ticket reads as one thing.
  assert.equal(path.dirname(specPath(repoRoot, ID)), path.dirname(auditPath(repoRoot, ID)));
});

// The docs tree is git-tracked, so unlike .glafka/ an old spec really can
// still be sitting there. It must keep holding its name, or a new ticket
// silently reuses an id whose spec and branch already exist.
test('a spec left by an older glafka still holds the ticket name', () => {
  const repoRoot = tempDir();
  const stateDir = tempDir();
  const legacy = path.join(repoRoot, 'docs/glafka/specs', `${ID}.md`);
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, '# spec\n');

  assert.equal(ticketIdTaken({ stateDir, repoRoot, id: ID }), 'a spec from an older glafka');
});

// Every path builder must reject a bad ticket id.
test('every path builder refuses an id that is not a real ticket id', () => {
  const root = tempDir();
  const builders = {
    ticketFiles: (id: string) => ticketFiles(ticketsDir(root), id),
    ticketLockPath: (id: string) => ticketLockPath(root, id),
    runFiles: (id: string) => runFiles(root, id),
    worktreePath: (id: string) => worktreePath(root, id),
    specPath: (id: string) => specPath(root, id),
    auditPath: (id: string) => auditPath(root, id),
    planPath: (id: string) => planPath(root, id),
  };

  for (const [name, build] of Object.entries(builders)) {
    for (const bad of BAD_IDS) {
      assert.throws(
        () => build(bad),
        /invalid ticket id/,
        `${name} accepted ${JSON.stringify(bad)}`,
      );
    }
  }
});

test('a real worktree path passes the delete guard', () => {
  const repoRoot = tempDir();

  const checked = assertIsTicketWorktree(worktreePath(repoRoot, ID));

  assert.equal(checked, path.resolve(repoRoot, '.worktrees', ID));
});

// This check matters most: a bad ticket file could name any
// folder to delete, even one with real work in it.
test('the delete guard refuses anything not shaped like a ticket worktree', () => {
  for (const bad of [
    '/',
    '/Users/someone',
    '/etc',
    '/Users/someone/project',
    // Right id, wrong folder — this is not a real checkout.
    `/Users/someone/project/docs/${ID}`,
    // Right folder, wrong name — this protects other folders.
    '/Users/someone/project/.worktrees/important-stuff',
    '/Users/someone/project/.worktrees',
  ]) {
    assert.throws(
      () => assertIsTicketWorktree(bad),
      /not a ticket worktree/,
      `guard accepted ${JSON.stringify(bad)}`,
    );
  }
});

// This looser check allows cleanup of any file in .worktrees,
// even ones that are not shaped like a ticket id.
test('the loose guard allows any entry listed out of .worktrees', () => {
  const repoRoot = '/Users/someone/project';

  for (const name of ['.DS_Store', 'leftover-tmp', ID]) {
    assert.doesNotThrow(
      () => assertUnderWorktreesRoot(repoRoot, path.join(worktreesRoot(repoRoot), name)),
      `loose guard rejected ${name}`,
    );
  }
});

test('the loose guard still refuses anything outside .worktrees', () => {
  const repoRoot = '/Users/someone/project';

  for (const bad of [
    '/',
    '/Users/someone',
    repoRoot,
    path.join(repoRoot, 'src'),
    // Too deep to be a direct child.
    path.join(worktreesRoot(repoRoot), ID, 'src'),
    // A folder name that only looks similar, not really inside.
    `${worktreesRoot(repoRoot)}-evil/thing`,
  ]) {
    assert.throws(
      () => assertUnderWorktreesRoot(repoRoot, bad),
      /not inside/,
      `loose guard accepted ${JSON.stringify(bad)}`,
    );
  }
});

// A moved or renamed repo still has a valid path shape.
// The check looks at shape, not the exact folder.
test('the delete guard allows a worktree from a checkout that has since moved', () => {
  assert.doesNotThrow(() => assertIsTicketWorktree(`/somewhere/else/.worktrees/${ID}`));
});

// This checks that no other file builds ticket paths on its own.
// All path building must go through this one module.
test('no module outside ticket/paths.js turns a ticket id into a path', () => {
  const srcRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
  const owner = path.join(srcRoot, 'ticket', 'paths.ts');

  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(full) : full;
    });

  // Finds any path.join(...) call that uses a raw id.
  // This is how paths are built everywhere in this code.
  const buildsPathFromId = (line: string) => /path\.join\([^)]*\bid\b/.test(line);

  // Checks the rule itself still works and catches real cases.
  assert.ok(buildsPathFromId('  return path.join(dir, `${id}.json`);'));
  assert.ok(buildsPathFromId('  const dir = path.join(stateDir, "background", id);'));
  assert.ok(!buildsPathFromId('  throw new Error(`ticket ${id} is already closed`);'));

  const offenders: string[] = [];
  for (const file of walk(srcRoot).filter((f) => f.endsWith('.ts') && f !== owner)) {
    fs.readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (line.trimStart().startsWith('//')) return;
        if (buildsPathFromId(line)) {
          offenders.push(`${path.relative(srcRoot, file)}:${i + 1}  ${line.trim()}`);
        }
      });
  }

  assert.deepEqual(
    offenders,
    [],
    `build these in src/ticket/paths.js instead, so the id is validated:\n${offenders.join('\n')}`,
  );
});

// These two scans read a directory and filter by name. Under the folder
// layout the wrong filter returns [], which reads as "nothing to worry
// about" — the one failure a green suite is least likely to catch.

test('listProvisioning still finds a provisioning lock beside the ticket folders', () => {
  const stateDir = tempDir();
  // A real ticket folder next to it, so the scan has to tell them apart.
  fs.mkdirSync(ticketFiles(ticketsDir(stateDir), ID).dir, { recursive: true });
  writeProvisioningLock(stateDir, ID, { branch: 'glafka/' + ID, ports: [4100] });

  const found = listProvisioning(stateDir);

  assert.equal(found.length, 1, 'the scan went quiet instead of finding the lock');
  assert.equal(found[0]!.id, ID);
  assert.equal(found[0]!.branch, `glafka/${ID}`);
  assert.deepEqual(found[0]!.ports, [4100]);
});

test('listFileLocks still finds a write lock beside the ticket folders', () => {
  const stateDir = tempDir();
  fs.mkdirSync(ticketFiles(ticketsDir(stateDir), ID).dir, { recursive: true });
  fs.writeFileSync(
    ticketLockPath(stateDir, ID),
    JSON.stringify({ pid: process.pid, startedAt: Date.now(), startProof: 1 }),
  );

  const found = listFileLocks(stateDir);

  assert.equal(found.length, 1, 'the scan went quiet instead of finding the lock');
  assert.equal(found[0]!.id, ID);
  assert.equal(found[0]!.corrupt, false);
});

// A lock whose holder died mid-write names no pid, so ownerIsGone can never call it
// stale — findOrphans has to be able to SEE it, or the ticket is blocked for good and the sweep built for it is blind.
test('a lock that names nobody is reported as corrupt', () => {
  const dir = makeTempDir('locks');
  const tickets = path.join(dir, 'tickets');
  fs.mkdirSync(tickets, { recursive: true });
  fs.writeFileSync(ticketLockPath(dir, '2026-08-07-a-live-ticket'), '');
  fs.writeFileSync(
    ticketLockPath(dir, '2026-08-03-a-lock-that-names-nobody'),
    JSON.stringify({ pid: 999999, startedAt: 1, startProof: 1 }),
  );

  const locks = listFileLocks(dir);
  const empty = locks.find((l) => l.id === '2026-08-07-a-live-ticket')!;
  const dead = locks.find((l) => l.id === '2026-08-03-a-lock-that-names-nobody')!;

  assert.equal(empty.corrupt, true, 'an unreadable lock must be reportable');
  assert.equal(isStaleFileLock(empty), false, 'and it is NOT stealable, which is why');
  assert.equal(dead.corrupt, false);
  assert.equal(isStaleFileLock(dead), true, 'a dead named holder is still stealable');

  fs.rmSync(dir, { recursive: true, force: true });
});
