import {
  readTicket,
  updateTicket,
  recordStage,
  archiveClosedTicket,
  pendingCandidates,
  decidePendingCandidates,
  STAGES,
  assertNotClosed,
  hasOpenPr,
  liveReviewerRoles,
} from '../../ticket/ticketStore.js';
import { releaseResources } from '../../ticket/resources.js';
import { publishAudit } from '../../audit/publish.js';
import { publishDecisions } from '../../ticket/decisions.js';
import { uncommittedPaths } from '../../util/git.js';
import { assertNoLiveRun } from '../../ticket/background.js';
import { assertNoLiveVerifier } from '../../ticket/liveVerifier.js';
import type { Ticket } from '../../types/ticket.js';
import { clearSessionClaims } from '../../../installKit/guardrails/index.js';

// Drops a ticket before it ships, even one with no worktree yet.
// We skip the cleanup step when there is no worktree to clean.
export async function cancel({
  repoRoot,
  stateDir,
  id,
  force = false,
}: {
  repoRoot: string;
  stateDir: string;
  id: string;
  force?: boolean;
}): Promise<Ticket> {
  const ticket = readTicket(stateDir, id);
  assertNotClosed(ticket);
  // With a PR already open, cancel is the wrong command.
  // Deleting the branch now would leave the PR broken.
  if (hasOpenPr(ticket)) {
    throw new Error(
      `ticket ${id} already has a PR (${ticket.prUrl}) — cancel is for abandoning a ticket ` +
        `before it ships, not after; use \`glafka lysis ${id}\` instead once the PR is merged or closed`,
    );
  }
  assertNoLiveRun({
    stateDir,
    id,
    action: 'cancelling',
    risk: 'tearing down a worktree a live agent is still writing to will corrupt it',
  });
  // cancel force-deletes the worktree, so it needs the reviewer check lysis already has — taken from
  // the ticket's own role list, so it is right for fan-out too.
  for (const role of liveReviewerRoles({ stateDir, id, ticket })) {
    assertNoLiveRun({
      stateDir,
      id,
      role,
      action: 'cancelling',
      risk:
        'deleting the worktree a live reviewer is reading loses its verdict, ' +
        'and its process fails for a reason no log explains',
    });
  }
  assertNoLiveVerifier({
    stateDir,
    id,
    action: 'cancelling',
    risk: 'deleting the worktree a live QA tester is testing loses its results',
  });

  // Same rule as lysis: uncommitted work dies with the worktree and no reflog holds it. A ticket still
  // in brainstorming has no worktree, so this never gets in the way of the common cancel.
  if (!force && ticket.worktree) {
    const dirty = uncommittedPaths(ticket.worktree);
    if (dirty.length > 0) {
      const shown = dirty.slice(0, 20);
      const more = dirty.length - shown.length;
      throw new Error(
        `ticket ${id} has ${dirty.length} uncommitted change(s) in its worktree — cancelling deletes ` +
          `the worktree, the branch keeps only committed work, and nothing brings these back:\n` +
          shown.map((line) => `  ${line}`).join('\n') +
          (more > 0 ? `\n  … and ${more} more` : '') +
          `\n\nKeep it:    git -C ${ticket.worktree} add -A && git -C ${ticket.worktree} commit -m "wip"\n` +
          `Throw away: glafka cancel ${id} --force`,
      );
    }
  }

  // A ticket still being planned has nothing to give back.
  if (ticket.worktree && ticket.branch) {
    await releaseResources({
      repoRoot,
      stateDir,
      ticket: { ...ticket, worktree: ticket.worktree, branch: ticket.branch },
    });
  }

  // Cancel throws away any waiting rules. It does not ask you first.
  if (pendingCandidates(ticket).length > 0) {
    decidePendingCandidates(stateDir, id, []);
  }

  // Locked read-modify-write — a raw writeTicket here could clobber a concurrent krisis/aporia write from a live agent.
  updateTicket(stateDir, id, () => ({}));
  recordStage(stateDir, id, STAGES.CANCEL);
  // Any session that claimed this ticket is done with it. Left behind, a session id the harness later
  // reuses would inherit a cage for finished work.
  clearSessionClaims({ stateDir, ticketId: id });
  // A cancelled ticket cost real tokens too, and its record dies with the
  // rest of the state. Same one-write-at-close rule as lysis.
  publishAudit({ repoRoot, stateDir, ticketId: id });
  // A cancelled ticket still decided things, and they die with the state.
  publishDecisions({ repoRoot, stateDir, ticketId: id });
  archiveClosedTicket(stateDir, id);
  return readTicket(stateDir, id);
}
