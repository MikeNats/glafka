import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeGitRepo } from '../helpers/gitFixture.js';
import {
  genesis,
  createTicket,
  attachSpec,
  attachPlan,
} from '../../src/commands/genesis/genesis.js';
import { cancel } from '../../src/commands/cancel/cancel.js';
import { makeTempDir } from '../helpers/tempDir.js';
import {
  readTicket,
  isActive,
  describeTicket,
  STAGES,
  lastStageIndex,
  appendEthosCandidate,
  withTicketLock,
} from '../../src/ticket/ticketStore.js';
import { ticketLockPath } from '../../src/ticket/paths.js';
import { currentBranch } from '../../src/util/git.js';
import { readDoc } from '../../src/memory/docsStore.js';
import { readRunRecords } from '../../src/audit/record.js';

function tempStateDir() {
  return makeTempDir('state');
}

function writeFile(content: string) {
  const filePath = path.join(makeTempDir('doc'), 'doc.md');
  fs.writeFileSync(filePath, content);
  return filePath;
}

// Simulates a concurrent writer already holding a ticket's lock.
function heldLock(stateDir: string, id: string) {
  const lockPath = ticketLockPath(stateDir, id);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), {
    flag: 'wx',
  });
  return lockPath;
}

test('createTicket writes a real, readable record with no resources yet', () => {
  const repoRoot = makeGitRepo();
  const stateDir = tempStateDir();

  const ticket = createTicket({ stateDir, repoRoot, content: 'add search filters' });

  assert.match(ticket.id, /^\d{4}-\d{2}-\d{2}-add-search-filters$/);

  assert.equal(ticket.branch!, null);
  assert.equal(ticket.worktree!, null);
  assert.equal(ticket.port, null);
  assert.equal(ticket.title, null);
  assert.equal(ticket.specText, 'add search filters');
  assert.match(ticket.created, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(describeTicket(ticket), 'brainstorming');

  // Check it is saved on disk, not just held in memory.
  assert.equal(readTicket(stateDir, ticket.id).id, ticket.id);
});

test('attachSpec moves a created ticket to spec-written, writes the spec doc, and captures the title', () => {
  const repoRoot = makeGitRepo();
  const stateDir = tempStateDir();
  const ticket = createTicket({ stateDir, repoRoot, content: 'add search filters' });
  const specPath = writeFile('# Spec: add search filters\n');

  const updated = attachSpec({
    stateDir,
    repoRoot,
    id: ticket.id,
    specPath,
    title: 'Add search filters',
  });

  assert.equal(describeTicket(updated), 'spec-written');
  assert.equal(updated.title, 'Add search filters');
  // The id is the whole filename, and the id already reads as words.
  assert.equal(updated.specPath, path.join(repoRoot, 'docs/glafka/tickets', ticket.id, 'spec.md'));
  assert.equal(readDoc(updated.specPath), '# Spec: add search filters\n');
  assert.equal(updated.specText, '# Spec: add search filters\n');
  // attachSpec does not create any resources yet.
  assert.equal(updated.worktree!, null);
});

// Nothing else in the audit ever mentions the spec: the session writes it, no
// process of ours runs, and the git copy read as a ticket that began at its
// first coder run.
test('attachSpec records the spec as work done on the ticket', () => {
  const repoRoot = makeGitRepo();
  const stateDir = tempStateDir();
  const ticket = createTicket({ stateDir, repoRoot, content: 'add search filters' });

  attachSpec({
    stateDir,
    repoRoot,
    id: ticket.id,
    specPath: writeFile('# Spec\n'),
    observability: true,
  });

  const [row] = readRunRecords(stateDir, ticket.id);
  assert.equal(row!.stage, 'genesis');
  assert.equal(row!.note, 'spec');
  assert.equal(row!.promptBytes, Buffer.byteLength('# Spec\n'));
  // Nobody measured it, and an unmeasured run must never read as a free one.
  assert.equal(row!.tokens, null);
  assert.equal(row!.durationMs, null);
});

test('attachSpec records nothing when observability is off', () => {
  const repoRoot = makeGitRepo();
  const stateDir = tempStateDir();
  const ticket = createTicket({ stateDir, repoRoot, content: 'add search filters' });

  attachSpec({ stateDir, repoRoot, id: ticket.id, specPath: writeFile('# Spec\n') });

  assert.equal(readRunRecords(stateDir, ticket.id).length, 0);
});

test('attachSpec is re-runnable freely before plan — a second pass just overwrites the first', () => {
  const repoRoot = makeGitRepo();
  const stateDir = tempStateDir();
  const ticket = createTicket({ stateDir, repoRoot, content: 'idea' });
  attachSpec({
    stateDir,
    repoRoot,
    id: ticket.id,
    specPath: writeFile('v1'),
    title: 'First title',
  });

  const second = attachSpec({
    stateDir,
    repoRoot,
    id: ticket.id,
    specPath: writeFile('v2'),
    title: 'Second title',
  });

  assert.equal(readDoc(second.specPath!), 'v2');
  assert.equal(second.title, 'Second title');
});

test('attachSpec keeps the existing title when none is given', () => {
  const repoRoot = makeGitRepo();
  const stateDir = tempStateDir();
  const ticket = createTicket({ stateDir, repoRoot, content: 'idea' });
  attachSpec({ stateDir, repoRoot, id: ticket.id, specPath: writeFile('v1'), title: 'Keep me' });

  const second = attachSpec({ stateDir, repoRoot, id: ticket.id, specPath: writeFile('v2') });

  assert.equal(second.title, 'Keep me');
});

test('attachPlan refuses without a spec first', { concurrency: true }, async () => {
  const repoRoot = makeGitRepo();
  const stateDir = tempStateDir();
  const ticket = createTicket({ stateDir, repoRoot, content: 'idea' });

  await assert.rejects(
    () => attachPlan({ repoRoot, stateDir, id: ticket.id, planPath: writeFile('plan') }),
    /has no spec yet/,
  );
});

test(
  'attachPlan acquires real resources, preserves the original created timestamp, and hands off exactly like genesis',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const created = createTicket({ stateDir, repoRoot, content: 'add search filters' });
    const withSpec = attachSpec({
      stateDir,
      repoRoot,
      id: created.id,
      specPath: writeFile('spec'),
      title: 'Add search filters',
    });

    // The middle link. Without this, the test only proves the timestamp
    // survives attachPlan, and a attachSpec that reset it would still pass.
    assert.equal(withSpec.created, created.created);

    const ticket = await attachPlan({
      stateDir,
      repoRoot,
      id: created.id,
      planPath: writeFile('1. do it'),
    });

    assert.equal(isActive(ticket), true);
    // The branch is the id, and the id is already the date plus the idea.
    assert.match(ticket.branch!, /^glafka\/\d{4}-\d{2}-\d{2}-add-search-filters$/);
    assert.equal(ticket.branch, `glafka/${ticket.id}`);
    assert.equal(fs.existsSync(ticket.worktree!), true);
    assert.equal(currentBranch(ticket.worktree!), ticket.branch!);
    assert.equal(ticket.title, 'Add search filters');
    // "created" is the time the idea started, not the time plan ran.
    assert.equal(ticket.created, created.created);
    assert.equal(ticket.id, created.id);
    assert.equal(describeTicket(ticket), 'planned');
    assert.equal(lastStageIndex(ticket, STAGES.PLAN) !== -1, true);
  },
);

test('attachPlan refuses to run twice on the same ticket', { concurrency: true }, async () => {
  const repoRoot = makeGitRepo();
  const stateDir = tempStateDir();
  const ticket = createTicket({ stateDir, repoRoot, content: 'idea' });
  attachSpec({ stateDir, repoRoot, id: ticket.id, specPath: writeFile('spec') });
  await attachPlan({ stateDir, repoRoot, id: ticket.id, planPath: writeFile('plan') });

  await assert.rejects(
    () => attachPlan({ stateDir, repoRoot, id: ticket.id, planPath: writeFile('plan again') }),
    /already has a worktree/,
  );
});

test('attachSpec refuses once resources already exist', { concurrency: true }, async () => {
  const repoRoot = makeGitRepo();
  const stateDir = tempStateDir();
  const ticket = createTicket({ stateDir, repoRoot, content: 'idea' });
  attachSpec({ stateDir, repoRoot, id: ticket.id, specPath: writeFile('spec') });
  await attachPlan({ stateDir, repoRoot, id: ticket.id, planPath: writeFile('plan') });

  assert.throws(
    () => attachSpec({ stateDir, repoRoot, id: ticket.id, specPath: writeFile('new spec') }),
    /already has a worktree/,
  );
});

// A cancelled ticket must stay cancelled, or cleanup could later
// delete work from a ticket that came back to life.
test('attachSpec refuses to revive a cancelled ticket', { concurrency: true }, async () => {
  const repoRoot = makeGitRepo();
  const stateDir = tempStateDir();
  const ticket = createTicket({ stateDir, repoRoot, content: 'idea' });
  await cancel({ repoRoot, stateDir, id: ticket.id });

  assert.throws(
    () => attachSpec({ stateDir, repoRoot, id: ticket.id, specPath: writeFile('spec') }),
    /already closed/,
  );
});

test('attachPlan refuses to revive a cancelled ticket', { concurrency: true }, async () => {
  const repoRoot = makeGitRepo();
  const stateDir = tempStateDir();
  const ticket = createTicket({ stateDir, repoRoot, content: 'idea' });
  attachSpec({ stateDir, repoRoot, id: ticket.id, specPath: writeFile('spec') });
  await cancel({ repoRoot, stateDir, id: ticket.id });

  await assert.rejects(
    () => attachPlan({ stateDir, repoRoot, id: ticket.id, planPath: writeFile('plan') }),
    /already closed/,
  );
});

// attachPlan must not lose ethosCandidates that were saved earlier.
test(
  'attachPlan preserves ethos candidates recorded during brainstorming and planning',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = createTicket({ stateDir, repoRoot, content: 'idea' });
    attachSpec({ stateDir, repoRoot, id: ticket.id, specPath: writeFile('spec') });

    appendEthosCandidate(stateDir, ticket.id, { target: 'ETHOS_CODE', text: 'rule one' });
    appendEthosCandidate(stateDir, ticket.id, { target: 'ETHOS_CODE', text: 'rule two' });
    assert.equal(readTicket(stateDir, ticket.id).ethosCandidates.length, 2);

    const afterPlan = await attachPlan({
      stateDir,
      repoRoot,
      id: ticket.id,
      planPath: writeFile('plan'),
    });

    assert.equal(afterPlan.ethosCandidates.length, 2);
    assert.equal(readTicket(stateDir, ticket.id).ethosCandidates.length, 2);
  },
);

test(
  'a full create -> spec -> plan chain produces a ticket shape-identical to genesis() directly',
  { concurrency: true },
  async () => {
    const repoRootA = makeGitRepo();
    const stateDirA = tempStateDir();

    const t = createTicket({ stateDir: stateDirA, repoRoot: repoRootA, content: 'x' });
    attachSpec({ stateDir: stateDirA, repoRoot: repoRootA, id: t.id, specPath: writeFile('x') });
    const viaPhases = await attachPlan({
      stateDir: stateDirA,
      repoRoot: repoRootA,
      id: t.id,
      planPath: writeFile('1. do it'),
    });

    const repoRootB = makeGitRepo();
    const stateDirB = tempStateDir();
    const viaGenesis = await genesis({
      repoRoot: repoRootB,
      stateDir: stateDirB,
      content: 'x',
      planContent: '1. do it',
    });

    const shape = (t: object) => Object.keys(t).sort();
    assert.deepEqual(shape(viaPhases), shape(viaGenesis));
    assert.equal(typeof viaPhases.branch!, 'string');
    assert.equal(typeof viaPhases.worktree!, 'string');
    assert.equal(typeof viaPhases.planCommit, 'string');
  },
);

// createTicket, attachSpec and attachPlan (via provisionTicket) used to write the
// ticket with no <id>.json.lock at all, the same class epistle.ts already fixed. They now go through updateTicket/withTicketLock, so a concurrent writer can't have its write silently clobbered — and a brand new id can't collide with itself either.

test('createTicket refuses to finish while another writer holds its own not-yet-created lock', () => {
  const stateDir = tempStateDir();
  // We can't know the random id createTicket will mint ahead of time, so this proves the shared locking
  // primitive it calls (withTicketLock) actually gates the write — the id is fixed here on purpose.
  const id = '2026-08-03-a-stored-ticket';
  const lockPath = ticketLockPath(stateDir, id);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), {
    flag: 'wx',
  });

  assert.throws(() => withTicketLock(stateDir, id, () => {}), /still locked/);
  fs.unlinkSync(lockPath);
});

test(
  'attachSpec refuses to finish while another writer holds the ticket lock',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = createTicket({ stateDir, repoRoot, content: 'lock me out' });
    const specPath = writeFile('# spec\n');

    const lockPath = heldLock(stateDir, ticket.id);
    assert.throws(
      () => attachSpec({ stateDir, repoRoot, id: ticket.id, specPath }),
      /still locked/,
    );
    fs.unlinkSync(lockPath);

    // Retrying after the lock clears must succeed cleanly.
    const updated = attachSpec({ stateDir, repoRoot, id: ticket.id, specPath });
    assert.equal(updated.specPath != null, true);
  },
);

test(
  'attachPlan (provisionTicket) refuses to finish while another writer holds the ticket lock',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = createTicket({ stateDir, repoRoot, content: 'lock me out' });
    attachSpec({ stateDir, repoRoot, id: ticket.id, specPath: writeFile('spec') });

    const lockPath = heldLock(stateDir, ticket.id);
    await assert.rejects(
      () => attachPlan({ stateDir, repoRoot, id: ticket.id, planPath: writeFile('1. do it') }),
      /still locked/,
    );
    fs.unlinkSync(lockPath);

    // The worktree acquireResources built before hitting the lock must not leak — provisionTicket's own
    // catch-and-cleanup path (not touched by this fix) is what's responsible for that.
    assert.deepEqual(fs.readdirSync(path.join(repoRoot, '.worktrees')), []);

    // Retrying after the lock clears must succeed cleanly.
    const provisioned = await attachPlan({
      stateDir,
      repoRoot,
      id: ticket.id,
      planPath: writeFile('1. do it'),
    });
    assert.equal(fs.existsSync(provisioned.worktree!), true);
  },
);
