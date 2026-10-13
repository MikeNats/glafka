import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeGitRepo } from '../helpers/gitFixture.js';
import { genesis } from '../../src/commands/genesis/genesis.js';
import { lysis, findOrphans, purgeOrphan } from '../../src/commands/lysis/lysis.js';
import type { Orphan } from '../../src/commands/lysis/lysis.js';
import { runFiles, decisionsDocPath } from '../../src/ticket/paths.js';
import { appendDecision, DECISION_SOURCE } from '../../src/ticket/decisions.js';
import { ergonBackground } from '../../src/commands/ergon/ergon.js';
import { makeTempDir } from '../helpers/tempDir.js';
import {
  readTicket,
  writeTicket,
  recordStage,
  isClosed,
  listTickets,
  STAGES,
  RUN_OUTCOMES,
  CANDIDATE_SOURCE,
} from '../../src/ticket/ticketStore.js';
import { ethosPath, readDoc, isolationProfilePath, writeDoc } from '../../src/memory/docsStore.js';
import { appendRunRecord, AUDIT_STAGES } from '../../src/audit/record.js';
import { ROLES } from '../../src/types/ticket.js';
import { DEFAULT_CATEGORIES, targetOf } from '../../src/memory/categories.js';
import {
  writeProvisioningLock,
  provisioningLockPath,
  ticketsDir,
  ticketFiles,
  ticketLockPath,
  auditPath,
} from '../../src/ticket/paths.js';

// Old default settings. Real settings now live in categories.json.
const T = Object.fromEntries(DEFAULT_CATEGORIES.map((c) => [c.name, targetOf(c)]));

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
  'lysis force-removes a worktree even with uncommitted changes',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'abandon this' });
    fs.writeFileSync(path.join(ticket.worktree!, 'half-done.txt'), 'meh\n');

    // --force is what makes this a force-removal now. Without it lysis refuses and names the file,
    // because nothing brings uncommitted work back (pinned at the bottom of this file).
    const closed = await lysis({ repoRoot, stateDir, id: ticket.id, force: true });

    assert.equal(isClosed(closed), true);
    assert.equal(fs.existsSync(ticket.worktree!), false);
    assert.equal(isClosed(readTicket(stateDir, ticket.id)), true);
  },
);

test('lysis removes a clean worktree just as well', { concurrency: true }, async () => {
  const repoRoot = makeGitRepo();
  const stateDir = tempStateDir();
  const ticket = await genesis({ repoRoot, stateDir, content: 'clean task' });

  const closed = await lysis({ repoRoot, stateDir, id: ticket.id });

  assert.equal(isClosed(closed), true);
  assert.equal(fs.existsSync(ticket.worktree!), false);
});

test(
  'lysis keeps the branch — it is the only record of the work',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'abandon this' });

    await lysis({ repoRoot, stateDir, id: ticket.id });

    const branches = execFileSync('git', ['branch', '--list', ticket.branch!], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert.match(branches, new RegExp(ticket.branch!));
  },
);

test('lysis refuses an already-closed ticket', { concurrency: true }, async () => {
  const repoRoot = makeGitRepo();
  const stateDir = tempStateDir();
  const ticket = await genesis({ repoRoot, stateDir, content: 'task' });
  await lysis({ repoRoot, stateDir, id: ticket.id });

  await assert.rejects(() => lysis({ repoRoot, stateDir, id: ticket.id }), /already closed/);
});

test(
  "lysis runs the profile's teardownCmd with the ticket's own ports",
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const marker = path.join(stateDir, 'teardown-ran.txt');
    writeDoc(
      isolationProfilePath(repoRoot),
      JSON.stringify({
        services: [{ name: 'db', envVars: ['DB_PORT'] }],
        teardownCmd: `echo "saw $DB_PORT for $GLAFKA_TICKET_ID" > "${marker}"`,
      }),
    );
    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });

    await lysis({ repoRoot, stateDir, id: ticket.id });

    const sawPort = fs.readFileSync(marker, 'utf8');
    assert.match(sawPort, new RegExp(`saw \\d+ for ${ticket.id}`));
  },
);

test("lysis runs the profile's e2e teardownCmd too", { concurrency: true }, async () => {
  const repoRoot = makeGitRepo();
  const stateDir = tempStateDir();
  const marker = path.join(stateDir, 'e2e-teardown-ran.txt');
  writeDoc(
    isolationProfilePath(repoRoot),
    JSON.stringify({
      services: [{ name: 'db', envVars: ['DB_PORT'] }],
      e2e: {
        services: [{ name: 'e2e-db', envVars: ['E2E_DB_PORT'] }],
        teardownCmd: `echo done > "${marker}"`,
      },
    }),
  );
  const ticket = await genesis({ repoRoot, stateDir, content: 'task' });

  await lysis({ repoRoot, stateDir, id: ticket.id });

  assert.equal(fs.existsSync(marker), true);
});

test('lysis refuses to close a ticket whose PR is still open', { concurrency: true }, async () => {
  const repoRoot = makeGitRepo();
  const stateDir = tempStateDir();
  const ticket = await genesis({ repoRoot, stateDir, content: 'task' });
  writeTicket(stateDir, { ...ticket, prUrl: 'https://github.com/x/y/pull/1' });
  const getPrState = () => 'OPEN';

  await assert.rejects(
    () => lysis({ repoRoot, stateDir, id: ticket.id, getPrState }),
    /PR is still open/,
  );
  assert.equal(fs.existsSync(ticket.worktree!), true);
});

test('lysis proceeds when the PR has been merged', { concurrency: true }, async () => {
  const repoRoot = makeGitRepo();
  const stateDir = tempStateDir();
  const ticket = await genesis({ repoRoot, stateDir, content: 'task' });
  writeTicket(stateDir, { ...ticket, prUrl: 'https://github.com/x/y/pull/1' });
  const getPrState = () => 'MERGED';

  const closed = await lysis({ repoRoot, stateDir, id: ticket.id, getPrState });

  assert.equal(isClosed(closed), true);
  assert.equal(fs.existsSync(ticket.worktree!), false);
});

test(
  'lysis proceeds when the PR was closed without merging (an explicit abandon, not ambiguous)',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });
    writeTicket(stateDir, { ...ticket, prUrl: 'https://github.com/x/y/pull/1' });
    const getPrState = () => 'CLOSED';

    const closed = await lysis({ repoRoot, stateDir, id: ticket.id, getPrState });

    assert.equal(isClosed(closed), true);
  },
);

// A crashed run and an open PR are checked separately.
// lysis still asks GitHub, even after a crash.
test(
  'lysis still consults GitHub when the last run crashed and a PR is open',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });
    writeTicket(stateDir, { ...ticket, prUrl: 'https://github.com/x/y/pull/1' });
    recordStage(stateDir, ticket.id, STAGES.ERGON, RUN_OUTCOMES.CRASHED);
    let asked = false;
    const getPrState = () => {
      asked = true;
      return 'OPEN';
    };

    await assert.rejects(
      () => lysis({ repoRoot, stateDir, id: ticket.id, getPrState }),
      /PR is still open/,
    );
    assert.equal(asked, true, 'GitHub was never asked');
    assert.equal(fs.existsSync(ticket.worktree!), true);
  },
);

// If `gh` is broken, that is not a real answer.
// The error message must say how to fix it.
test(
  "lysis refuses, in its own words, when GitHub can't be asked at all",
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });
    writeTicket(stateDir, { ...ticket, prUrl: 'https://github.com/x/y/pull/1' });
    const getPrState = () => {
      throw new Error('spawnSync gh ENOENT');
    };

    await assert.rejects(
      () => lysis({ repoRoot, stateDir, id: ticket.id, getPrState }),
      (err: Error) => {
        assert.match(err.message, /can't ask GitHub/);
        assert.match(err.message, /spawnSync gh ENOENT/, 'the real cause has to survive');
        assert.match(err.message, /--pr-settled/, 'a refusal with no way past it is a dead end');
        return true;
      },
    );
    // A refusal must keep the ticket safe: work, port, and files all stay.
    assert.equal(fs.existsSync(ticket.worktree!), true);
    assert.equal(isClosed(readTicket(stateDir, ticket.id)), false);
    const active = listTickets(stateDir, { includeClosed: false }).map((t) => t.id);
    assert.equal(active.includes(ticket.id), true);
    assert.equal(findOrphans({ repoRoot, stateDir }).orphanWorktrees.includes(ticket.id), false);
  },
);

// `--pr-settled` means "nobody could check", not "check said no".
// Example: agent died, PR merged by hand, `gh` is broken.
test(
  "--pr-settled closes a ticket GitHub couldn't be asked about, and records that nobody checked",
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });
    writeTicket(stateDir, { ...ticket, prUrl: 'https://github.com/x/y/pull/1' });
    recordStage(stateDir, ticket.id, STAGES.ERGON, RUN_OUTCOMES.CRASHED);
    const getPrState = () => {
      throw new Error('gh: not logged in');
    };

    const closed = await lysis({ repoRoot, stateDir, id: ticket.id, prSettled: true, getPrState });

    assert.equal(isClosed(closed), true);
    assert.equal(fs.existsSync(ticket.worktree!), false);
    // Do not make it look like the PR was checked, when it was not.
    const log = closed.stageLog;
    assert.equal(log[log.length - 1].stage, 'lysis');
    assert.equal(log[log.length - 1].note, 'pr-settled');
    // Closing frees the port for the next ticket.
    assert.equal(listTickets(stateDir, { includeClosed: false }).length, 0);
  },
);

// `--pr-settled` must not skip a PR that GitHub says is open.
test(
  '--pr-settled does not get past a PR GitHub says is still open',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });
    writeTicket(stateDir, { ...ticket, prUrl: 'https://github.com/x/y/pull/1' });
    let asked = false;
    const getPrState = () => {
      asked = true;
      return 'OPEN';
    };

    await assert.rejects(
      () => lysis({ repoRoot, stateDir, id: ticket.id, prSettled: true, getPrState }),
      /PR is still open/,
    );
    assert.equal(asked, true, 'GitHub is still consulted, flag or no flag');
    assert.equal(fs.existsSync(ticket.worktree!), true);
  },
);

// No note means nothing was skipped.
test('an ordinary close records no note on its lysis entry', { concurrency: true }, async () => {
  const repoRoot = makeGitRepo();
  const stateDir = tempStateDir();
  const ticket = await genesis({ repoRoot, stateDir, content: 'task' });

  const closed = await lysis({ repoRoot, stateDir, id: ticket.id, prSettled: true });

  const log = closed.stageLog;
  assert.equal(log[log.length - 1].stage, 'lysis');
  assert.equal(log[log.length - 1].note, null, 'nothing was skipped, so nothing to record');
});

// A crashed last run is a normal reason to close a ticket.
// lysis must allow this, or the ticket can never close.
test('lysis closes a ticket whose last run crashed', { concurrency: true }, async () => {
  const repoRoot = makeGitRepo();
  const stateDir = tempStateDir();
  const ticket = await genesis({ repoRoot, stateDir, content: 'abandon this' });
  recordStage(stateDir, ticket.id, STAGES.ERGON, RUN_OUTCOMES.CRASHED);

  const closed = await lysis({ repoRoot, stateDir, id: ticket.id });

  assert.equal(isClosed(closed), true);
  assert.equal(fs.existsSync(ticket.worktree!), false);
});

test(
  'lysis refuses while a background ergon run is still going',
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
      () => lysis({ repoRoot, stateDir, id: ticket.id }),
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

// This used to fail: lysis deleted the branch, and a stale lock made that throw.
// Now lysis never touches the branch, so the same lock is none of its business.
test(
  'a stale branch lock no longer blocks lysis, because lysis does not touch the branch',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });
    const lockPath = path.join(repoRoot, '.git', 'refs', 'heads', `${ticket.branch!}.lock`);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, '');

    await lysis({ repoRoot, stateDir, id: ticket.id });

    assert.equal(fs.existsSync(ticket.worktree!), false);
  },
);

// One candidate per target, so a wrong pick is easy to see.
async function ticketWithCandidates(repoRoot: string, stateDir: string) {
  const ticket = await genesis({ repoRoot, stateDir, content: 'task' });
  writeTicket(stateDir, {
    ...ticket,
    ethosCandidates: [
      { status: 'pending', source: 'agent', target: T.CODE, text: 'prefer small functions' },
      { status: 'pending', source: 'you', target: T.SECURITY, text: 'never log request bodies' },
      {
        status: 'pending',
        source: 'agent',
        target: T.TESTING,
        text: 'every endpoint needs a 401 test',
      },
    ],
  });
  return ticket;
}

test(
  'lysis promotes the selected ethos candidates into the permanent docs',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await ticketWithCandidates(repoRoot, stateDir);

    const closed = await lysis({ repoRoot, stateDir, id: ticket.id, keep: 'all' });

    assert.match(readDoc(ethosPath(repoRoot, T.CODE)), /prefer small functions/);
    assert.match(readDoc(ethosPath(repoRoot, T.SECURITY)), /never log request bodies/);
    assert.match(readDoc(ethosPath(repoRoot, T.TESTING)), /401 test/);
    assert.equal(closed.promoted.length, 3);
  },
);

// Agents write these candidates.
// Auto-saving them would let an agent's idea become a permanent rule.
test(
  'lysis REFUSES to close a ticket whose candidates nobody ruled on',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await ticketWithCandidates(repoRoot, stateDir);

    await assert.rejects(
      () => lysis({ repoRoot, stateDir, id: ticket.id }),
      /3 ethos candidate\(s\) awaiting a decision/,
    );

    // The error lists the candidates with numbers, and shows a way out.
    await assert.rejects(() => lysis({ repoRoot, stateDir, id: ticket.id }), /1\. \[ETHOS_CODE\]/);
    await assert.rejects(() => lysis({ repoRoot, stateDir, id: ticket.id }), /--keep all/);
    await assert.rejects(() => lysis({ repoRoot, stateDir, id: ticket.id }), /--keep none/);
  },
);

// If cleanup ran before the check, it would delete the worktree, then fail.
// Then there is nothing left to go back to.
test(
  'a refused close is a no-op — worktree, branch, and the ticket all survive',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await ticketWithCandidates(repoRoot, stateDir);

    await assert.rejects(() => lysis({ repoRoot, stateDir, id: ticket.id }));

    assert.equal(fs.existsSync(ticket.worktree!), true, 'worktree was destroyed before the gate');
    assert.equal(isClosed(readTicket(stateDir, ticket.id)), false);
    const branches = execFileSync('git', ['branch', '--list', ticket.branch!], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert.match(branches, new RegExp(ticket.branch!));
    // Nothing leaked into permanent docs.
    assert.equal(fs.existsSync(ethosPath(repoRoot, T.CODE)), false);
  },
);

test('lysis --keep with indices keeps only those, and closes', { concurrency: true }, async () => {
  const repoRoot = makeGitRepo();
  const stateDir = tempStateDir();
  const ticket = await ticketWithCandidates(repoRoot, stateDir);

  const closed = await lysis({ repoRoot, stateDir, id: ticket.id, keep: '1,3' });

  assert.equal(isClosed(closed), true);
  assert.match(readDoc(ethosPath(repoRoot, T.CODE)), /prefer small functions/);
  assert.match(readDoc(ethosPath(repoRoot, T.TESTING)), /401 test/);
  assert.equal(fs.existsSync(ethosPath(repoRoot, T.SECURITY)), false);
});

// Promoting could throw (bad categories.json, an unwritable docs/glafka/ethos/,
// EISDIR, ENOSPC) AFTER the ticket already recorded the candidates as 'kept'. On retry, pendingCandidates() would then be empty, so nothing would be promoted a second time — the human-approved rule would be gone for good. Promoting first means a failure here leaves the candidates still 'pending', so fixing the cause and retrying actually recovers them.
test(
  'a promote failure leaves the candidates pending, not silently lost as "kept"',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await ticketWithCandidates(repoRoot, stateDir);

    // Block the write: a directory sits where the ethos doc should be
    // written, so promoteEthosCandidates throws instead of writing.
    fs.mkdirSync(ethosPath(repoRoot, T.CODE), { recursive: true });

    await assert.rejects(() => lysis({ repoRoot, stateDir, id: ticket.id, keep: 'all' }));

    // Not silently marked 'kept' with nothing to show for it.
    const after = readTicket(stateDir, ticket.id);
    assert.equal(isClosed(after), false);
    assert.equal(
      after.ethosCandidates.every((c) => c.status === 'pending'),
      true,
    );

    // Fix the cause and retry: the rules are still there to promote.
    fs.rmdirSync(ethosPath(repoRoot, T.CODE));
    const closed = await lysis({ repoRoot, stateDir, id: ticket.id, keep: 'all' });
    assert.equal(closed.promoted.length, 3);
    assert.match(readDoc(ethosPath(repoRoot, T.CODE)), /prefer small functions/);
  },
);

// This write used to be a raw writeTicket with no <id>.json.lock, the same
// class epistle.ts already fixed. It now goes through updateTicket, so a concurrent writer (e.g. a running krisis/aporia) can't have its write silently clobbered.
test(
  'lysis refuses to finish while another writer holds the ticket lock',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'lock me out' });

    const lockPath = ticketLockPath(stateDir, ticket.id);
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), {
      flag: 'wx',
    });

    await assert.rejects(() => lysis({ repoRoot, stateDir, id: ticket.id }), /still locked/);
    fs.unlinkSync(lockPath);

    // The stage write and the lock-guarded write are ordered so a failure here never leaves the ticket
    // looking closed (per isClosed(), which reads the stage log) without actually being archived — otherwise a retry would hit "already closed" forever with the worktree gone but the ticket stuck open.
    assert.equal(isClosed(readTicket(stateDir, ticket.id)), false);

    // Retrying after the lock clears must succeed cleanly, not "already closed".
    const closed = await lysis({ repoRoot, stateDir, id: ticket.id });
    assert.equal(isClosed(closed), true);
  },
);

test('lysis --keep none closes and writes nothing permanent', { concurrency: true }, async () => {
  const repoRoot = makeGitRepo();
  const stateDir = tempStateDir();
  const ticket = await ticketWithCandidates(repoRoot, stateDir);

  const closed = await lysis({ repoRoot, stateDir, id: ticket.id, keep: 'none' });

  assert.equal(isClosed(closed), true);
  assert.equal(closed.promoted.length, 0);
  assert.equal(fs.existsSync(ethosPath(repoRoot, T.CODE)), false);
  // Not saved, but not erased either. Still visible on the ticket.
  assert.equal(readTicket(stateDir, ticket.id).ethosCandidates.length, 3);
});

// A typo in the input must not partly work.
// That could save the wrong rule by accident.
test(
  'a malformed --keep selection is refused outright, not partially applied',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await ticketWithCandidates(repoRoot, stateDir);

    await assert.rejects(
      () => lysis({ repoRoot, stateDir, id: ticket.id, keep: '9' }),
      /out of range/,
    );
    await assert.rejects(
      () => lysis({ repoRoot, stateDir, id: ticket.id, keep: '1,x' }),
      /isn't a number/,
    );
    await assert.rejects(
      () => lysis({ repoRoot, stateDir, id: ticket.id, keep: '0' }),
      /out of range/,
    );
    await assert.rejects(
      () => lysis({ repoRoot, stateDir, id: ticket.id, keep: '' }),
      /needs "all", "none"/,
    );

    assert.equal(isClosed(readTicket(stateDir, ticket.id)), false);
    assert.equal(fs.existsSync(ethosPath(repoRoot, T.CODE)), false);
  },
);

test('a repeated index promotes once, not twice', { concurrency: true }, async () => {
  const repoRoot = makeGitRepo();
  const stateDir = tempStateDir();
  const ticket = await ticketWithCandidates(repoRoot, stateDir);

  const closed = await lysis({ repoRoot, stateDir, id: ticket.id, keep: '2,2' });

  assert.equal(closed.promoted.length, 1);
  const security = readDoc(ethosPath(repoRoot, T.SECURITY));
  assert.equal(security!.match(/never log request bodies/g)!.length, 1);
});

// Most tickets have no candidates. They should still close in one step.
test(
  'a ticket with no candidates still closes with no --keep needed',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });

    const closed = await lysis({ repoRoot, stateDir, id: ticket.id });

    assert.equal(isClosed(closed), true);
    assert.deepEqual(closed.promoted, []);
  },
);

// If the review step already decided the candidates,
// closing later does not ask again.
test(
  "a ticket already decided at ergon's review step closes silently, no --keep needed",
  { concurrency: true },
  async () => {
    const { ergonReviewDecide } = await import('../../src/commands/ergon/ergon.js');
    const { appendEthosCandidate, pendingCandidates } =
      await import('../../src/ticket/ticketStore.js');
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });
    appendEthosCandidate(stateDir, ticket.id, {
      target: T.SECURITY,
      text: 'never log request bodies',
      source: CANDIDATE_SOURCE.YOU,
    });
    ergonReviewDecide({ repoRoot, stateDir, id: ticket.id, keep: 'all' });

    const closed = await lysis({ repoRoot, stateDir, id: ticket.id });

    assert.equal(isClosed(closed), true);
    assert.deepEqual(closed.promoted, [], 'lysis re-promoted what the review step already handled');
    assert.deepEqual(pendingCandidates(readTicket(stateDir, ticket.id)), []);
    assert.match(readDoc(ethosPath(repoRoot, T.SECURITY)), /never log request bodies/);
  },
);

// A candidate added after that decision still needs its own check.
test(
  'lysis still gates on a candidate recorded after the review-step decision',
  { concurrency: true },
  async () => {
    const { ergonReviewDecide } = await import('../../src/commands/ergon/ergon.js');
    const { appendEthosCandidate } = await import('../../src/ticket/ticketStore.js');
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });
    appendEthosCandidate(stateDir, ticket.id, { target: T.CODE, text: 'decided at review' });
    ergonReviewDecide({ repoRoot, stateDir, id: ticket.id, keep: 'all' });

    appendEthosCandidate(stateDir, ticket.id, { target: T.TESTING, text: 'recorded late' });

    await assert.rejects(
      () => lysis({ repoRoot, stateDir, id: ticket.id }),
      /1 ethos candidate\(s\) awaiting a decision/,
    );
    assert.equal(fs.existsSync(ticket.worktree!), true, 'refused close destroyed the worktree');

    const closed = await lysis({ repoRoot, stateDir, id: ticket.id, keep: 'all' });
    assert.deepEqual(
      closed.promoted.map((c) => c.text),
      ['recorded late'],
    );
  },
);

// --- findOrphans / purgeOrphan: cleans up the whole repo (`lysis <id> --sweep`) ---

test(
  'findOrphans reports nothing orphaned for a freshly-opened, still-open ticket',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    await genesis({ repoRoot, stateDir, content: 'task' });

    const result = findOrphans({ repoRoot, stateDir });

    assert.deepEqual(result.orphanWorktrees, []);
    assert.deepEqual(result.orphanBranches, []);
  },
);

// lysis keeps the branch, so the sweep is the only thing that can ever remove it.
// It has to be offered here, or a closed ticket's branch could never be cleaned.
test(
  'a closed ticket leaves no worktree, and its branch becomes a sweep candidate',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });
    await lysis({ repoRoot, stateDir, id: ticket.id });

    const result = findOrphans({ repoRoot, stateDir });

    assert.deepEqual(result.orphanWorktrees, []);
    assert.deepEqual(result.orphanBranches, [ticket.branch!]);
  },
);

test(
  'findOrphans finds a worktree directory left behind with no ticket file',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    fs.mkdirSync(path.join(repoRoot, '.worktrees', '2026-08-07-sweep-the-leftovers'), {
      recursive: true,
    });

    const result = findOrphans({ repoRoot, stateDir });

    assert.deepEqual(result.orphanWorktrees, ['2026-08-07-sweep-the-leftovers']);
  },
);

test(
  'findOrphans finds a glafka/* branch with no matching ticket file',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    execFileSync('git', ['branch', 'glafka/2026-08-07-sweep-the-leftovers'], { cwd: repoRoot });

    const result = findOrphans({ repoRoot, stateDir });

    assert.deepEqual(result.orphanBranches, ['glafka/2026-08-07-sweep-the-leftovers']);
  },
);

// A ticket file that fails to parse used to just vanish from activeIds, so its very
// own live worktree and branch dropped out of the "still active" set and got offered up for deletion as if abandoned. The whole sweep must refuse instead, since the list it would build is known to be incomplete.
test(
  'findOrphans refuses the whole sweep when a ticket file is unreadable, not just skips it',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });

    // Cut off mid-write, the way a full disk (or a hand-edit) leaves a file.
    // Its worktree and branch are still on disk and still very much live.
    const { ticketFile } = ticketFiles(ticketsDir(stateDir), ticket.id);
    fs.writeFileSync(ticketFile, `{"id":"${ticket.id}","cont`);

    assert.throws(() => findOrphans({ repoRoot, stateDir }), /ticket file\(s\) could not be read/);
  },
);

// Tests the case where files exist but the ticket is still being made.
// Without this check, a ticket being set up would look abandoned.
test(
  'findOrphans does not flag a worktree/branch that is still mid-provisioning',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    execFileSync(
      'git',
      [
        'worktree',
        'add',
        '-b',
        'glafka/2026-08-07-sweep-the-leftovers',
        path.join(repoRoot, '.worktrees', '2026-08-07-sweep-the-leftovers'),
      ],
      { cwd: repoRoot },
    );
    fs.mkdirSync(path.join(stateDir, 'tickets'), { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'tickets', '2026-08-07-sweep-the-leftovers.provisioning'),
      JSON.stringify({ branch: 'glafka/2026-08-07-sweep-the-leftovers', ports: [] }),
    );

    const result = findOrphans({ repoRoot, stateDir });

    assert.equal(result.orphanWorktrees.includes('2026-08-07-sweep-the-leftovers'), false);
    assert.equal(result.orphanBranches.includes('glafka/2026-08-07-sweep-the-leftovers'), false);
  },
);

// If the process dies before cleanup, the lock file stays forever.
// A dead process ID is one way to find this.
test(
  'findOrphans reaps a provisioning lock whose process is dead, and unhides its worktree/branch',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    execFileSync(
      'git',
      [
        'worktree',
        'add',
        '-b',
        'glafka/2026-08-07-sweep-the-leftovers',
        path.join(repoRoot, '.worktrees', '2026-08-07-sweep-the-leftovers'),
      ],
      { cwd: repoRoot },
    );
    fs.mkdirSync(path.join(stateDir, 'tickets'), { recursive: true });
    writeProvisioningLock(stateDir, '2026-08-07-sweep-the-leftovers', {
      branch: 'glafka/2026-08-07-sweep-the-leftovers',
      ports: [],
      pid: 999999, // fake ID, no real process
      startedAt: Date.now(),
    });

    const { orphanWorktrees, orphanBranches, orphans } = findOrphans({ repoRoot, stateDir });

    assert.equal(orphanWorktrees.includes('2026-08-07-sweep-the-leftovers'), true);
    assert.equal(orphanBranches.includes('glafka/2026-08-07-sweep-the-leftovers'), true);
    const lockOrphan = orphans.find((o) => o.kind === 'provisioningLock');
    assert.equal(lockOrphan?.id, '2026-08-07-sweep-the-leftovers');
  },
);

// Other case: the process is alive, but the lock is too old.
// It has lasted longer than setup is allowed to take.
test(
  'findOrphans reaps a provisioning lock that has outlived bootstrapTimeoutMs, even with a live pid',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    execFileSync(
      'git',
      [
        'worktree',
        'add',
        '-b',
        'glafka/2026-08-07-sweep-the-leftovers',
        path.join(repoRoot, '.worktrees', '2026-08-07-sweep-the-leftovers'),
      ],
      { cwd: repoRoot },
    );
    fs.mkdirSync(path.join(stateDir, 'tickets'), { recursive: true });
    writeProvisioningLock(stateDir, '2026-08-07-sweep-the-leftovers', {
      branch: 'glafka/2026-08-07-sweep-the-leftovers',
      ports: [],
      pid: process.pid, // real, running process
      startedAt: Date.now() - 20 * 60 * 1000,
    });

    const past = findOrphans({ repoRoot, stateDir, bootstrapTimeoutMs: 15 * 60 * 1000 });
    assert.equal(past.orphanWorktrees.includes('2026-08-07-sweep-the-leftovers'), true);

    const stillWithinBudget = findOrphans({
      repoRoot,
      stateDir,
      bootstrapTimeoutMs: 60 * 60 * 1000,
    });
    assert.equal(
      stillWithinBudget.orphanWorktrees.includes('2026-08-07-sweep-the-leftovers'),
      false,
    );
  },
);

test(
  'purgeOrphan on a provisioningLock orphan deletes the lock file',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    fs.mkdirSync(path.join(stateDir, 'tickets'), { recursive: true });
    writeProvisioningLock(stateDir, '2026-08-07-sweep-the-leftovers', {
      branch: 'glafka/2026-08-07-sweep-the-leftovers',
      ports: [],
      pid: 999999,
      startedAt: Date.now(),
    });

    const { orphans } = findOrphans({ repoRoot, stateDir });
    const lockOrphan = orphans.find((o) => o.kind === 'provisioningLock');
    await purgeOrphan({ repoRoot, stateDir, orphan: lockOrphan! });

    assert.equal(
      fs.existsSync(provisioningLockPath(stateDir, '2026-08-07-sweep-the-leftovers')),
      false,
    );
  },
);

// Old lock files had no process ID or time. A killed process left
// them behind forever. Same idea as the tests above, for write-locks.
function tempLockPath(stateDir: string, id: string) {
  return ticketLockPath(stateDir, id);
}

test(
  'findOrphans reaps a ticket write-lock whose holder process is dead',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });
    fs.mkdirSync(ticketsDir(stateDir), { recursive: true });
    fs.writeFileSync(
      tempLockPath(stateDir, ticket.id),
      JSON.stringify({ pid: 999999, startedAt: Date.now() }), // fake ID, no real process
    );

    const { orphans } = findOrphans({ repoRoot, stateDir });

    const lockOrphan = orphans.find((o) => o.kind === 'fileLock');
    assert.equal(lockOrphan?.id, ticket.id);
  },
);

test(
  'findOrphans reaps a ticket write-lock that has outlived the staleness ceiling, even with a live pid',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });
    fs.writeFileSync(
      tempLockPath(stateDir, ticket.id),
      JSON.stringify({ pid: process.pid, startedAt: Date.now() - 5 * 60 * 1000 }), // real, running process
    );

    const { orphans } = findOrphans({ repoRoot, stateDir });

    const lockOrphan = orphans.find((o) => o.kind === 'fileLock');
    assert.equal(lockOrphan?.id, ticket.id);
  },
);

test(
  'findOrphans does not flag a fresh, live ticket write-lock',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });
    fs.writeFileSync(
      tempLockPath(stateDir, ticket.id),
      JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
    );

    const { orphans } = findOrphans({ repoRoot, stateDir });

    assert.equal(
      orphans.some((o) => o.kind === 'fileLock'),
      false,
    );
  },
);

test('purgeOrphan on a fileLock orphan deletes the lock file', { concurrency: true }, async () => {
  const repoRoot = makeGitRepo();
  const stateDir = tempStateDir();
  const ticket = await genesis({ repoRoot, stateDir, content: 'task' });
  const lockPath = tempLockPath(stateDir, ticket.id);
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, startedAt: Date.now() }));

  const { orphans } = findOrphans({ repoRoot, stateDir });
  const lockOrphan = orphans.find((o) => o.kind === 'fileLock');
  await purgeOrphan({ repoRoot, stateDir, orphan: lockOrphan! });

  assert.equal(fs.existsSync(lockPath), false);
});

test(
  'findOrphans does not flag a worktree/branch that still has a real, open ticket',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });

    const result = findOrphans({ repoRoot, stateDir });

    assert.equal(result.orphanWorktrees.includes(ticket.id), false);
    assert.equal(result.orphanBranches.includes(ticket.branch!), false);
  },
);

// A crashed worktree should stay, so you can debug it later.
// The cleanup sweep must not delete it.
test(
  'findOrphans does not flag the worktree of a ticket whose last run crashed',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });
    recordStage(stateDir, ticket.id, STAGES.ERGON, RUN_OUTCOMES.CRASHED);

    const result = findOrphans({ repoRoot, stateDir });

    assert.equal(result.orphanWorktrees.includes(ticket.id), false);
    assert.equal(result.orphanBranches.includes(ticket.branch!), false);
    assert.equal(fs.existsSync(ticket.worktree!), true);
  },
);

test('findOrphans never deletes anything — report-only', { concurrency: true }, async () => {
  const repoRoot = makeGitRepo();
  const stateDir = tempStateDir();
  const orphanDir = path.join(repoRoot, '.worktrees', '2026-08-07-sweep-the-leftovers');
  fs.mkdirSync(orphanDir, { recursive: true });

  findOrphans({ repoRoot, stateDir });

  assert.equal(fs.existsSync(orphanDir), true);
});

// Removing a category leaves its old file on disk with unused rules.
// The cleanup sweep should flag this file.
test(
  'findOrphans reports an ethos file whose category is gone from categories.json',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    writeDoc(
      path.join(repoRoot, 'docs/glafka/ethos/categories.json'),
      JSON.stringify([{ name: 'DOMAIN', hint: 'billing' }]),
    );
    writeDoc(path.join(repoRoot, 'docs/glafka/ethos/ETHOS_DOMAIN.md'), '# ETHOS_DOMAIN\n');
    writeDoc(
      path.join(repoRoot, 'docs/glafka/ethos/ETHOS_LEGACY.md'),
      '# ETHOS_LEGACY\n\n- a dead rule\n',
    );

    const { orphanEthosFiles } = findOrphans({ repoRoot, stateDir });

    assert.deepEqual(orphanEthosFiles, ['ETHOS_LEGACY.md']);
  },
);

test(
  'findOrphans leaves configured ethos files and categories.json alone',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    // No categories.json, so default settings apply.
    writeDoc(path.join(repoRoot, 'docs/glafka/ethos/ETHOS_CODE.md'), '# ETHOS_CODE\n');
    writeDoc(path.join(repoRoot, 'docs/glafka/ethos/ETHOS_AI.md'), '# ETHOS_AI\n');

    assert.deepEqual(findOrphans({ repoRoot, stateDir }).orphanEthosFiles, []);
  },
);

test(
  'findOrphans reports nothing about ethos in a project that has none',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();

    assert.deepEqual(findOrphans({ repoRoot, stateDir }).orphanEthosFiles, []);
  },
);

// One flat list. A caller can go through it one item at a time.
test('orphans is one flat list, worktrees BEFORE branches', { concurrency: true }, async () => {
  const repoRoot = makeGitRepo();
  const stateDir = tempStateDir();
  const ticket = await genesis({ repoRoot, stateDir, content: 'task' });
  // Pretend a crash happened: files stay, but the ticket is gone.
  fs.rmSync(ticketFiles(ticketsDir(stateDir), ticket.id).ticketFile);

  const { orphans } = findOrphans({ repoRoot, stateDir });
  const kinds = orphans.map((o) => o.kind);

  // Git can't delete a checked-out branch. Remove the worktree first.
  assert.ok(kinds.indexOf('worktree') < kinds.indexOf('branch'), `bad order: ${kinds}`);
  for (const orphan of orphans) {
    assert.ok(orphan.label, 'orphan has no label to show a human');
    assert.ok(orphan.detail, 'orphan has no detail explaining why it is orphaned');
  }
});

test(
  'purgeOrphan deletes a worktree, then its branch, then its port',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });
    // Pretend a crash happened: files stay, but the ticket is gone.
    fs.rmSync(ticketFiles(ticketsDir(stateDir), ticket.id).ticketFile);

    const { orphans } = findOrphans({ repoRoot, stateDir });
    for (const orphan of orphans) await purgeOrphan({ repoRoot, stateDir, orphan });

    assert.equal(fs.existsSync(ticket.worktree!), false);
    const branches = execFileSync('git', ['branch', '--list', ticket.branch!], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert.equal(branches.trim(), '');
    assert.deepEqual(findOrphans({ repoRoot, stateDir }).orphans, []);
  },
);

// A half-finished setup leaves a folder git does not know about.
// It still needs to be deleted.
test(
  'purgeOrphan removes a worktree directory git never registered',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const stray = path.join(repoRoot, '.worktrees', '2026-08-07-sweep-the-leftovers');
    fs.mkdirSync(stray, { recursive: true });
    fs.writeFileSync(path.join(stray, 'leftover.txt'), 'x\n');

    const { orphans } = findOrphans({ repoRoot, stateDir });
    assert.deepEqual(
      orphans.map((o) => o.kind),
      ['worktree'],
    );
    await purgeOrphan({ repoRoot, stateDir, orphan: orphans[0] });

    assert.equal(fs.existsSync(stray), false);
  },
);

test('purgeOrphan deletes a dead ethos file', { concurrency: true }, async () => {
  const repoRoot = makeGitRepo();
  const stateDir = tempStateDir();
  writeDoc(
    path.join(repoRoot, 'docs/glafka/ethos/categories.json'),
    JSON.stringify([{ name: 'DOMAIN', hint: 'billing' }]),
  );
  const dead = path.join(repoRoot, 'docs/glafka/ethos/ETHOS_LEGACY.md');
  writeDoc(dead, '# ETHOS_LEGACY\n\n- a dead rule\n');

  const { orphans } = findOrphans({ repoRoot, stateDir });
  await purgeOrphan({ repoRoot, stateDir, orphan: orphans.find((o) => o.kind === 'ethosFile')! });

  assert.equal(fs.existsSync(dead), false);
});

// Better to refuse an unknown type than guess how to delete it.
test(
  'purgeOrphan refuses a kind it does not know how to delete',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();

    await assert.rejects(
      () =>
        purgeOrphan({
          repoRoot,
          stateDir: tempStateDir(),
          // This is not a real Orphan type, on purpose.
          // It tests the runtime check, not something TypeScript would allow.
          orphan: { kind: 'database', label: 'x' } as unknown as Orphan,
        }),
      /unknown orphan kind "database"/,
    );
  },
);

// Old bug: a safety check was too strict and blocked normal junk files.
// What matters is the path is inside .worktrees, not the file name.
test('purgeOrphan removes a stray entry that is not named like a ticket', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = tempStateDir();
  const worktrees = path.join(repoRoot, '.worktrees');
  fs.mkdirSync(worktrees, { recursive: true });
  fs.writeFileSync(path.join(worktrees, '.DS_Store'), 'junk');
  fs.mkdirSync(path.join(worktrees, 'leftover-tmp'), { recursive: true });

  const { orphans } = findOrphans({ repoRoot, stateDir });
  assert.deepEqual(orphans.map((o) => o.label).sort(), [
    '.worktrees/.DS_Store',
    '.worktrees/leftover-tmp',
  ]);

  for (const orphan of orphans) {
    await purgeOrphan({ repoRoot, stateDir, orphan });
  }

  assert.deepEqual(fs.readdirSync(worktrees), []);
});

// Old bug: lysis did not check if a reviewer was still reading the worktree.
// It deleted the worktree mid-read, and the reviewer crashed.
test('lysis refuses to tear down a worktree a live reviewer is reading', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = tempStateDir();
  const ticket = await genesis({ repoRoot, stateDir, content: 'work' });

  // A reviewer run that is genuinely still going.
  const { dir, pidPath, logPath } = runFiles(stateDir, ticket.id, 'reviewer');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(pidPath, String(process.pid));
  fs.writeFileSync(logPath, '');

  await assert.rejects(
    () => lysis({ repoRoot, stateDir, id: ticket.id, keep: 'all' }),
    /reviewer|review/i,
  );
  assert.equal(fs.existsSync(ticket.worktree!), true, 'the worktree must still be there');
});

// ---------------------------------------------------------------------------

// lysis deletes the worktree, and no reflog holds work that was never committed. It
// used to do that silently, in one line, exit 0 — while epistle, which is reversible, refused and explained itself. The dangerous command was the quiet one.
test(
  'lysis refuses to destroy uncommitted work, and names the files',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'careful' });
    fs.writeFileSync(path.join(ticket.worktree!, 'important.js'), 'work nobody committed\n');

    await assert.rejects(
      () => lysis({ repoRoot, stateDir, id: ticket.id }),
      (err: Error) =>
        /uncommitted change/.test(err.message) &&
        err.message.includes('important.js') &&
        err.message.includes('--force'),
    );

    // Nothing may be gone after a refusal.
    assert.equal(fs.existsSync(ticket.worktree!), true);
    assert.equal(fs.existsSync(path.join(ticket.worktree!, 'important.js')), true);
    assert.equal(isClosed(readTicket(stateDir, ticket.id)), false);
  },
);

test('lysis --force throws the work away, deliberately', { concurrency: true }, async () => {
  const repoRoot = makeGitRepo();
  const stateDir = tempStateDir();
  const ticket = await genesis({ repoRoot, stateDir, content: 'careful' });
  fs.writeFileSync(path.join(ticket.worktree!, 'important.js'), 'work\n');

  const closed = await lysis({ repoRoot, stateDir, id: ticket.id, force: true });

  assert.equal(isClosed(closed), true);
  assert.equal(fs.existsSync(ticket.worktree!), false);
});

test('a clean worktree still closes with no --force', { concurrency: true }, async () => {
  const repoRoot = makeGitRepo();
  const stateDir = tempStateDir();
  const ticket = await genesis({ repoRoot, stateDir, content: 'clean' });

  const closed = await lysis({ repoRoot, stateDir, id: ticket.id });

  assert.equal(isClosed(closed), true);
  assert.equal(fs.existsSync(ticket.worktree!), false);
});

// The .glafka/ record dies with the ticket. This copy is the only thing that
// survives a fresh clone, and it is written once, at close — never appended
// to during a run, which would dirty the main checkout under a live agent.
test('lysis publishes the run rows into git, and the state folder goes', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = tempStateDir();
  const ticket = await genesis({ repoRoot, stateDir, content: 'record this' });
  appendRunRecord(stateDir, ticket.id, {
    at: '2026-08-08T10:00:00.000Z',
    kind: 'run',
    stage: AUDIT_STAGES.ERGON,
    role: ROLES.CODER,
    agent: 'claude',
    durationMs: 1000,
    exitCode: 0,
    promptBytes: 10,
    responseBytes: 20,
    tokens: { in: 5, out: 7 },
    tokenSource: 'test',
  });

  await lysis({ repoRoot, stateDir, id: ticket.id });

  const published = auditPath(repoRoot, ticket.id);
  assert.ok(fs.existsSync(published), 'the audit was not published at close');
  const rows = fs
    .readFileSync(published, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  // Both logs, merged by time. The run record alone left the git audit — the
  // only copy that outlives the state directory — with no create, no spec
  // and no plan on it.
  const runs = rows.filter((row) => row.kind === 'run');
  assert.equal(runs.length, 1);
  assert.equal(runs[0].tokens.in, 5);
  assert.ok(rows.some((row) => row.kind === 'stage'));
  // And the live state is gone from the open folder, folder and all.
  assert.equal(fs.existsSync(ticketFiles(ticketsDir(stateDir), ticket.id).dir), false);
});

// A ticket nobody ever ran still has a history, and it is exactly the history
// someone asks for later: how far did this get? What it must never do is leave
// a row claiming a run that never happened.
test('closing a ticket that never ran publishes its history and no runs', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = tempStateDir();
  const ticket = await genesis({ repoRoot, stateDir, content: 'never ran' });

  await lysis({ repoRoot, stateDir, id: ticket.id });

  const rows = fs
    .readFileSync(auditPath(repoRoot, ticket.id), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { kind: string });
  assert.equal(
    rows.some((row) => row.kind === 'run'),
    false,
  );
  assert.ok(rows.every((row) => row.kind === 'stage'));
  assert.ok(rows.length > 0);
});

// --------------------------------------------------------------------------- Decisions survive the
// close, the same way the audit record does. ---------------------------------------------------------------------------

test('lysis copies the decisions into git', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = makeTempDir('state');
  const ticket = await genesis({ repoRoot, stateDir, content: 'task' });
  appendDecision(stateDir, ticket.id, {
    source: DECISION_SOURCE.PERSON,
    text: 'no lat/lon input',
  });

  await lysis({ repoRoot, stateDir, id: ticket.id });

  const published = fs.readFileSync(decisionsDocPath(repoRoot, ticket.id), 'utf8');
  assert.match(published, /no lat\/lon input/);
});

test('a ticket that decided nothing publishes no decisions file', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = makeTempDir('state');
  const ticket = await genesis({ repoRoot, stateDir, content: 'task' });

  await lysis({ repoRoot, stateDir, id: ticket.id });

  assert.equal(fs.existsSync(decisionsDocPath(repoRoot, ticket.id)), false);
});
