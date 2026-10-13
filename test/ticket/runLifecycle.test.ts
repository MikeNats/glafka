import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { makeTempDir } from '../helpers/tempDir.js';

import {
  markExternalRunStarted,
  markExternalRunFinished,
  backgroundStatus,
  assertNoLiveRun,
  callerRunOrigin,
} from '../../src/ticket/background.js';
import { runRolesOnDisk, runsDir } from '../../src/ticket/paths.js';
import { liveReviewerRoles } from '../../src/ticket/ticketStore.js';
import { branchesInUseByWorktrees } from '../../src/util/git.js';
import type { Ticket } from '../../src/types/ticket.js';

const ID = '2026-08-07-add-search-filters';

function tmpState(): string {
  return makeTempDir('runs');
}

// ---------------------------------------------------------------------------

// A run dispatched into someone's own session has no process glafka owns, so nothing
// ever wrote its exit code. It read as "running" for good: poreia showed it forever, and every later command had to warn past it.
test('an externally dispatched run can be ended, and then reads as finished', () => {
  const stateDir = tmpState();
  assert.equal(backgroundStatus({ stateDir, id: ID }).state, 'not-started');

  markExternalRunStarted({ stateDir, id: ID, role: 'coder' });
  assert.equal(backgroundStatus({ stateDir, id: ID }).state, 'running');

  assert.equal(markExternalRunFinished({ stateDir, id: ID }), true);
  assert.equal(backgroundStatus({ stateDir, id: ID }).state, 'finished');
});

test('ending it twice changes nothing the second time', () => {
  const stateDir = tmpState();
  markExternalRunStarted({ stateDir, id: ID, role: 'coder' });
  assert.equal(markExternalRunFinished({ stateDir, id: ID }), true);
  assert.equal(markExternalRunFinished({ stateDir, id: ID }), false);
});

test('a stopped run no longer makes later commands warn their way past it', () => {
  const stateDir = tmpState();
  markExternalRunStarted({ stateDir, id: ID, role: 'coder' });
  markExternalRunFinished({ stateDir, id: ID });

  const status = assertNoLiveRun({ stateDir, id: ID, action: 'reviewing', risk: 'x' });
  assert.equal(status.state, 'finished');
});

test('aporia ends it as FAILED — stopped without finishing is not a clean finish', () => {
  const stateDir = tmpState();
  markExternalRunStarted({ stateDir, id: ID, role: 'coder' });
  markExternalRunFinished({ stateDir, id: ID, exitCode: 1 });
  assert.equal(backgroundStatus({ stateDir, id: ID }).state, 'failed');
});

test('a run glafka SPAWNED is never overwritten — its real exit code is the truth', () => {
  const stateDir = tmpState();
  const dir = path.join(runsDir(stateDir, ID), 'coder');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pid'), String(process.pid));
  fs.writeFileSync(path.join(dir, 'log'), '');
  fs.writeFileSync(path.join(dir, 'started-at'), String(Date.now()));

  assert.equal(markExternalRunFinished({ stateDir, id: ID }), false);
  assert.equal(backgroundStatus({ stateDir, id: ID }).state, 'running');
});

test('with nothing dispatched there is no run to end', () => {
  assert.equal(markExternalRunFinished({ stateDir: tmpState(), id: ID }), false);
});

test('a new run clears the last one’s ending', () => {
  const stateDir = tmpState();
  markExternalRunStarted({ stateDir, id: ID, role: 'coder' });
  markExternalRunFinished({ stateDir, id: ID });
  assert.equal(backgroundStatus({ stateDir, id: ID }).state, 'finished');

  markExternalRunStarted({ stateDir, id: ID, role: 'coder' });
  assert.equal(
    backgroundStatus({ stateDir, id: ID }).state,
    'running',
    'a stale exit code must not make a fresh run look already over',
  );
});

// ---------------------------------------------------------------------------

// Every liveness guard read the roles off the ticket file. A reviewer that IS
// running but is missing from that list was invisible to all of them, and its worktree got deleted under it.
const bareTicket = (extra: Partial<Ticket> = {}) => ({ id: ID, ...extra }) as Ticket;

test('a reviewer with a run folder is seen even when the ticket file forgot it', () => {
  const stateDir = tmpState();
  fs.mkdirSync(path.join(runsDir(stateDir, ID), 'reviewer-security'), { recursive: true });

  const roles = liveReviewerRoles({ stateDir, id: ID, ticket: bareTicket({ reviewerRoles: [] }) });
  assert.ok(roles.includes('reviewer-security'), 'the disk is what proves a run started');
});

test('the ticket’s own roles are still honoured, and the two are unioned', () => {
  const stateDir = tmpState();
  fs.mkdirSync(path.join(runsDir(stateDir, ID), 'reviewer-perf'), { recursive: true });

  const roles = liveReviewerRoles({
    stateDir,
    id: ID,
    ticket: bareTicket({ reviewerRoles: ['reviewer-security'] }),
  });
  assert.deepEqual(new Set(roles), new Set(['reviewer-security', 'reviewer-perf']));
});

test('the coder folder is not swept up as a reviewer', () => {
  const stateDir = tmpState();
  fs.mkdirSync(path.join(runsDir(stateDir, ID), 'coder'), { recursive: true });

  const roles = liveReviewerRoles({ stateDir, id: ID, ticket: bareTicket({ reviewerRoles: [] }) });
  assert.equal(roles.includes('coder'), false, 'the coder is guarded separately');
});

test('a pre-fan-out ticket still reads as the single "reviewer" role', () => {
  const roles = liveReviewerRoles({
    stateDir: tmpState(),
    id: ID,
    ticket: bareTicket({ reviewerRoles: [] }),
  });
  assert.deepEqual(roles, ['reviewer']);
});

test('no runs folder at all is not an error', () => {
  assert.deepEqual(runRolesOnDisk(tmpState(), ID), []);
});

// ---------------------------------------------------------------------------

// The round token proves someone READ the prompt, not who is calling. A string
// copied out of a prompt worked from anywhere, including from the coder, which is the one caller the token exists to exclude.
test('with no reviewer running the question is unanswerable, so the token stands alone', () => {
  const stateDir = tmpState();
  const { origin } = callerRunOrigin({ stateDir, id: ID, roles: ['reviewer'] });
  assert.equal(origin, 'unanswerable', 'the documented manual review path must keep working');
});

test('a call from outside a live reviewer’s process tree is refused trust', (t) => {
  if (process.platform === 'win32') return t.skip('no process ancestry on Windows');
  const stateDir = tmpState();
  const dir = path.join(runsDir(stateDir, ID), 'reviewer');
  fs.mkdirSync(dir, { recursive: true });
  // A live process that is certainly NOT one of our ancestors. This used to be pid 1, which is not a
  // usable stand-in any more: pid 1 is alive and in another group, but it is the ancestor of every
  // process on the machine, so an ancestry test reads it as "inside" from anywhere. Our own child is
  // the honest shape of the case — alive, unrelated to the chain above us.
  const other = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  other.unref();
  fs.writeFileSync(path.join(dir, 'pid'), String(other.pid));

  try {
    const { origin } = callerRunOrigin({ stateDir, id: ID, roles: ['reviewer'] });
    assert.equal(origin, 'outside');
  } finally {
    try {
      process.kill(other.pid!);
    } catch {
      // Already gone is fine.
    }
  }
});

// pid 1 is alive, and every process descends from it. Trusting that would make
// 'outside' unreachable on a ticket whose pid file was ever wrong.
test('pid 1 is never a run to be inside of', (t) => {
  if (process.platform === 'win32') return t.skip('no process ancestry on Windows');
  const stateDir = tmpState();
  const dir = path.join(runsDir(stateDir, ID), 'reviewer');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pid'), '1');

  const { origin } = callerRunOrigin({ stateDir, id: ID, roles: ['reviewer'] });
  assert.equal(origin, 'outside');
});

test('a call from inside the reviewer’s own process tree is trusted', (t) => {
  if (process.platform === 'win32') return t.skip('no process ancestry on Windows');
  const stateDir = tmpState();
  const dir = path.join(runsDir(stateDir, ID), 'reviewer');
  fs.mkdirSync(dir, { recursive: true });

  // Our own parent. A real krisis call sits further down than this — the reviewer starts a shell,
  // the shell starts node — and the walk has to cross those steps, which the old group test could
  // not do once a runner put its tool calls in a group of their own.
  const ourParent = execFileSync('ps', ['-o', 'ppid=', '-p', String(process.pid)], {
    encoding: 'utf8',
  }).trim();
  fs.writeFileSync(path.join(dir, 'pid'), ourParent);

  const { origin } = callerRunOrigin({ stateDir, id: ID, roles: ['reviewer'] });
  assert.equal(origin, 'inside');
});

test('a reviewer that already exited leaves no group to belong to', () => {
  const stateDir = tmpState();
  const dir = path.join(runsDir(stateDir, ID), 'reviewer');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pid'), '999999');

  const { origin } = callerRunOrigin({ stateDir, id: ID, roles: ['reviewer'] });
  assert.equal(origin, 'unanswerable');
});

// ---------------------------------------------------------------------------

// findOrphans built its branch list from the ticket files. A branch whose
// ticket file disagreed with what the worktree really checked out was proposed for deletion while a live checkout was on it.
test('git itself says which branches a live worktree is standing on', () => {
  const repoRoot = makeTempDir('orphan');
  const git = (args: string[]) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  git(['init', '-q', '-b', 'main', '.']);
  git(['config', 'user.email', 'test@glafka.dev']);
  git(['config', 'user.name', 'glafka test']);
  fs.writeFileSync(path.join(repoRoot, 'a.txt'), 'x\n');
  git(['add', 'a.txt']);
  git(['commit', '-q', '-m', 'seed']);
  git(['worktree', 'add', '-q', `.worktrees/${ID}`, '-b', `glafka/${ID}`]);

  const inUse = branchesInUseByWorktrees(repoRoot);
  assert.ok(inUse.has(`glafka/${ID}`), 'the ticket branch is held by its worktree');
  assert.ok(inUse.has('main'), 'the main checkout holds its own branch too');
  assert.match(String(inUse.get(`glafka/${ID}`)), /\.worktrees/);

  // A branch nothing has checked out is free to be swept.
  git(['branch', 'glafka/abandoned']);
  assert.equal(branchesInUseByWorktrees(repoRoot).has('glafka/abandoned'), false);
});

test('a detached worktree holds no branch', () => {
  const repoRoot = makeTempDir('orphan2');
  const git = (args: string[]) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  git(['init', '-q', '-b', 'main', '.']);
  git(['config', 'user.email', 'test@glafka.dev']);
  git(['config', 'user.name', 'glafka test']);
  fs.writeFileSync(path.join(repoRoot, 'a.txt'), 'x\n');
  git(['add', 'a.txt']);
  git(['commit', '-q', '-m', 'seed']);
  git(['worktree', 'add', '-q', '--detach', '.worktrees/loose']);

  const inUse = branchesInUseByWorktrees(repoRoot);
  assert.equal(inUse.size, 1, 'only main; the detached one contributes nothing');
  assert.ok(inUse.has('main'));
});
