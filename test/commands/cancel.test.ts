import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeGitRepo } from '../helpers/gitFixture.js';
import { genesis, createTicket } from '../../src/commands/genesis/genesis.js';
import { ergonBackground } from '../../src/commands/ergon/ergon.js';
import { epistle } from '../../src/commands/epistle/epistle.js';
import { cancel } from '../../src/commands/cancel/cancel.js';
import { makeTempDir } from '../helpers/tempDir.js';
import {
  readTicket,
  listTickets,
  describeTicket,
  pendingCandidates,
  appendEthosCandidate,
  isClosed,
  isCancelled,
  CANDIDATE_SOURCE,
} from '../../src/ticket/ticketStore.js';
import { addBareRemote } from '../helpers/gitFixture.js';
import { ticketLockPath, auditPath, decisionsDocPath } from '../../src/ticket/paths.js';
import { appendDecision, DECISION_SOURCE } from '../../src/ticket/decisions.js';
import { appendRunRecord, AUDIT_STAGES } from '../../src/audit/record.js';
import { ROLES } from '../../src/types/ticket.js';

function tempStateDir() {
  return makeTempDir('state');
}

// 60s, not 20s. These wait on a real spawned process, and a full `npm test` saturates the machine, so
// a cold process can take well past 20s to be scheduled. The assertions are about ordering, not speed.
function waitFor(
  predicate: () => boolean,
  { timeoutMs = 60000, intervalMs = 20 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('timed out waiting'));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

test(
  'cancel on a still-brainstorming ticket (no resources) just archives it — no crash from a null worktree/branch',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = createTicket({ stateDir, repoRoot, content: 'an idea nobody will approve' });

    const result = await cancel({ repoRoot, stateDir, id: ticket.id });

    assert.equal(describeTicket(result), 'cancelled');
    assert.equal(
      listTickets(stateDir).some((t) => t.id === ticket.id),
      false,
    );
    assert.equal(
      listTickets(stateDir, { includeClosed: true }).some((t) => t.id === ticket.id),
      true,
    );
  },
);

test(
  'cancel on a ticket with real resources actually removes the worktree and branch',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'abandon this' });
    assert.equal(fs.existsSync(ticket.worktree!), true);

    await cancel({ repoRoot, stateDir, id: ticket.id });

    assert.equal(fs.existsSync(ticket.worktree!), false);
  },
);

test('cancel refuses an already-closed (cancelled) ticket', { concurrency: true }, async () => {
  const repoRoot = makeGitRepo();
  const stateDir = tempStateDir();
  const ticket = createTicket({ stateDir, repoRoot, content: 'idea' });
  await cancel({ repoRoot, stateDir, id: ticket.id });

  await assert.rejects(() => cancel({ repoRoot, stateDir, id: ticket.id }), /already closed/);
});

// cancel must not delete the branch and worktree if a PR is open.
// That would leave the PR with no trace of why it was left behind.
test(
  'cancel refuses once the ticket has a PR, even one still open',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    addBareRemote(repoRoot);
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'ship this' });
    await epistle({
      stateDir,
      id: ticket.id,
      repoRoot,
      unreviewed: true,
      createPr: () => 'https://example/pull/1',
    });

    await assert.rejects(() => cancel({ repoRoot, stateDir, id: ticket.id }), /already has a PR/);
    assert.equal(fs.existsSync(ticket.worktree!), true);
  },
);

test(
  'cancel refuses while a background ergon run is still going',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'task', planContent: '1. do it' });
    const { pid } = await ergonBackground({
      stateDir,
      id: ticket.id,
      repoRoot,
      agentCmd: 'sleep 30',
    });

    await assert.rejects(
      () => cancel({ repoRoot, stateDir, id: ticket.id }),
      /background ergon run still/,
    );
    assert.equal(fs.existsSync(ticket.worktree!), true);

    process.kill(pid!, 'SIGKILL');
    return waitFor(() => {
      try {
        process.kill(pid!, 0);
        return false;
      } catch {
        return true;
      }
    });
  },
);

// cancel throws away the ticket, so it skips the ethos check that lysis does.
test(
  'cancel silently discards pending ethos candidates instead of requiring a ruling',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = createTicket({ stateDir, repoRoot, content: 'idea' });
    appendEthosCandidate(stateDir, ticket.id, {
      target: 'CODE',
      text: 'some rule',
      source: CANDIDATE_SOURCE.AGENT,
    });
    assert.equal(pendingCandidates(readTicket(stateDir, ticket.id)).length, 1);

    await cancel({ repoRoot, stateDir, id: ticket.id });

    // Main check: cancel did not fail because of undecided candidates.
    const closed = readTicket(stateDir, ticket.id);
    assert.equal(pendingCandidates(closed).length, 0);
  },
);

// This write used to be a raw writeTicket with no <id>.json.lock, the same
// class epistle.ts already fixed. It now goes through updateTicket, so a concurrent writer (e.g. a running krisis/aporia) can't have its write silently clobbered.
test(
  'cancel refuses to finish while another writer holds the ticket lock',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = createTicket({ stateDir, repoRoot, content: 'lock me out' });

    const lockPath = ticketLockPath(stateDir, ticket.id);
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), {
      flag: 'wx',
    });

    await assert.rejects(() => cancel({ repoRoot, stateDir, id: ticket.id }), /still locked/);
    fs.unlinkSync(lockPath);

    // The lock-guarded write happens BEFORE the CANCEL stage is recorded, so a failure here must not
    // leave the ticket looking closed (per isClosed(), which reads the stage log, not the archive location) — otherwise a retry would hit "already closed" forever.
    assert.equal(isClosed(readTicket(stateDir, ticket.id)), false);

    // Retrying after the lock clears must succeed cleanly, not "already closed".
    const closed = await cancel({ repoRoot, stateDir, id: ticket.id });
    assert.equal(isClosed(closed), true);
  },
);

// ---------------------------------------------------------------------------

// cancel force-deletes the same worktree lysis does, so it needs the same guard. A ticket still in
// brainstorming has no worktree, so the common cancel is untouched.
test(
  'cancel refuses to destroy uncommitted work unless forced',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'careful' });
    fs.writeFileSync(path.join(ticket.worktree!, 'important.js'), 'work\n');

    await assert.rejects(
      () => cancel({ repoRoot, stateDir, id: ticket.id }),
      (err: Error) => /uncommitted change/.test(err.message) && err.message.includes('--force'),
    );
    assert.equal(fs.existsSync(path.join(ticket.worktree!, 'important.js')), true);

    const cancelled = await cancel({ repoRoot, stateDir, id: ticket.id, force: true });
    assert.equal(isCancelled(cancelled), true);
  },
);

// A cancelled ticket cost real tokens too, and its record dies with the rest
// of the state. Same one-write-at-close rule lysis follows.
test('cancel publishes the run rows into git before the state goes', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = tempStateDir();
  const ticket = await genesis({ repoRoot, stateDir, content: 'abandon after a run' });
  appendRunRecord(stateDir, ticket.id, {
    at: '2026-08-08T10:00:00.000Z',
    kind: 'run',
    stage: AUDIT_STAGES.ERGON,
    role: ROLES.CODER,
    agent: 'claude',
    durationMs: 1000,
    exitCode: 1,
    promptBytes: 10,
    responseBytes: 20,
    tokens: { in: 11, out: 13 },
    tokenSource: 'test',
  });

  await cancel({ repoRoot, stateDir, id: ticket.id, force: true });

  const published = auditPath(repoRoot, ticket.id);
  assert.ok(fs.existsSync(published), 'a cancelled ticket lost its cost record');
  const rows = fs
    .readFileSync(published, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  // The runs AND the history: how far a cancelled ticket got is the whole
  // reason to keep its audit at all.
  const runs = rows.filter((row) => row.kind === 'run');
  assert.equal(runs.length, 1);
  assert.equal(runs[0].tokens.in, 11);
  assert.ok(rows.some((row) => row.kind === 'stage'));
});

// --------------------------------------------------------------------------- Decisions survive the
// close, the same way the audit record does. ---------------------------------------------------------------------------

test('cancel copies the decisions into git', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = makeTempDir('state');
  const ticket = await genesis({ repoRoot, stateDir, content: 'task' });
  appendDecision(stateDir, ticket.id, {
    source: DECISION_SOURCE.PERSON,
    text: 'no lat/lon input',
  });

  await cancel({ repoRoot, stateDir, id: ticket.id });

  const published = fs.readFileSync(decisionsDocPath(repoRoot, ticket.id), 'utf8');
  assert.match(published, /no lat\/lon input/);
});

test('a cancelled ticket that decided nothing publishes no decisions file', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = makeTempDir('state');
  const ticket = await genesis({ repoRoot, stateDir, content: 'task' });

  await cancel({ repoRoot, stateDir, id: ticket.id });

  assert.equal(fs.existsSync(decisionsDocPath(repoRoot, ticket.id)), false);
});
