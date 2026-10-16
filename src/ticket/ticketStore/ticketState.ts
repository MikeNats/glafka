import { STAGES, RUN_OUTCOMES, lastStageIndex, currentStage } from './stages.js';
import { reviewedCodeChanged } from './reviewedTree.js';
import type { Ticket } from '../../types/ticket.js';

// --------------------------------------------------------------------------- Values worked out from the ticket, never saved

// The bad endings. CHECKS_UNKNOWN is left out on purpose,
// because some repos have no test script at all.
const BAD_OUTCOMES: Set<string> = new Set([
  RUN_OUTCOMES.CHECKS_FAILED,
  RUN_OUTCOMES.TIMED_OUT,
  RUN_OUTCOMES.CRASHED,
  // A run someone stopped half-way left the branch half-written, exactly like
  // a crash did. Only the reason is better news.
  RUN_OUTCOMES.CANCELLED,
]);

// True for good once cancel has run.
// Cancelled and closed are two different endings.
export function isCancelled(ticket: Ticket): boolean {
  return lastStageIndex(ticket, STAGES.CANCEL) !== -1;
}

// True for good once lysis or cancel has run.
export function isClosed(ticket: Ticket): boolean {
  return lastStageIndex(ticket, STAGES.LYSIS) !== -1 || isCancelled(ticket);
}

// We do not save if the PR is still open. Only GitHub knows that.
export function hasOpenPr(ticket: Ticket): boolean {
  return Boolean(ticket.prUrl);
}

// How the last ergon run ended, or null. The type is plain `string`
// because `note` is free text that every stage shares.
export function lastRunOutcome(ticket: Ticket): string | null {
  const lastRun = lastStageIndex(ticket, STAGES.ERGON);
  return lastRun === -1 ? null : ticket.stageLog[lastRun].note;
}

// True if the last ergon run crashed, timed out, or failed its checks.
export function lastRunFailed(ticket: Ticket): boolean {
  const outcome = lastRunOutcome(ticket);
  return outcome !== null && BAD_OUTCOMES.has(outcome);
}

// How the last review's checks went, or null.
export function lastReviewOutcome(ticket: Ticket): string | null {
  const lastReview = lastStageIndex(ticket, STAGES.REVIEW);
  return lastReview === -1 ? null : ticket.stageLog[lastReview].note;
}

// True only if the last review had failing checks.
// "checks-unknown" does not count, since many projects have no checks.
export function lastReviewFailed(ticket: Ticket): boolean {
  return lastReviewOutcome(ticket) === RUN_OUTCOMES.CHECKS_FAILED;
}

// True when the last review ran no checks at all. Separate from lastReviewFailed
// because it is a separate question: not "did it break", but "did anything look".
// Nothing ran and nothing to run are indistinguishable from here, and only a
// person can tell them apart — so this gates the push rather than deciding.
export function lastReviewUnverified(ticket: Ticket): boolean {
  return lastReviewOutcome(ticket) === RUN_OUTCOMES.CHECKS_UNKNOWN;
}

// Active means not closed. A crashed run still holds its port and worktree.
export function isActive(ticket: Ticket): boolean {
  return !isClosed(ticket);
}

// Every command that touches a ticket calls this first.
export function assertNotClosed(ticket: Ticket): void {
  if (!isClosed(ticket)) return;
  throw new Error(`ticket ${ticket.id} is already closed`);
}

// Stops review and push after a bad run.
// Shared by ergon's review step and epistle.
export function assertLastRunOk(ticket: Ticket, action: string): void {
  if (!lastRunFailed(ticket)) return;
  throw new Error(
    `ticket ${ticket.id}: the last ergon run ended ${lastRunOutcome(ticket)} — ` +
      `re-run ergon (or fix it by hand) before ${action}`,
  );
}

// True when the newest `review` entry is a QA round that stopped, so nobody acted on it yet.
// It still counts as a round: that is what keeps maxReviewRounds a real limit.
export function lastReviewQaBlocked(ticket: Ticket): boolean {
  const index = lastStageIndex(ticket, STAGES.REVIEW);
  return index !== -1 && ticket.stageLog[index].qaBlocked === true;
}

// The stage log alone: a review after the last ergon run. Blind to a commit made by hand.
export function reviewedAfterLastRun(ticket: Ticket): boolean {
  const reviewed = lastStageIndex(ticket, STAGES.REVIEW);
  if (reviewed === -1) return false;
  // No ergon run still counts. Hand-written code can be reviewed too.
  return reviewed > lastStageIndex(ticket, STAGES.ERGON);
}

// True only if a review ran after the last code change.
export function isReviewedSinceLastChange(ticket: Ticket): boolean {
  // A commit by hand adds no stage entry, so the code itself is compared too.
  return reviewedAfterLastRun(ticket) && !reviewedCodeChanged(ticket);
}

// Reviewed by the log, but the code moved since: a commit by hand. One wording everywhere.
export const UNREVIEWED_COMMIT = 'a commit no reviewer has read';
export function hasUnreviewedCommit(ticket: Ticket): boolean {
  return reviewedAfterLastRun(ticket) && reviewedCodeChanged(ticket);
}

// --------------------------------------------------------------------------- The one line the CLI prints

// A short label for each stage. Stage names are command names. Every label names what is DONE, in
// the same tense. The old list mixed the two — `spec` printed "planning" (what is next) while
// `plan` printed "spec" (what finished two steps back), so a ticket with an approved plan, a
// branch and a live worktree read as "still writing the spec" in the one line `poreia --all`
// prints.
const POSITIONS = new Map([
  [STAGES.CREATE, 'brainstorming'],
  [STAGES.SPEC, 'spec-written'],
  // Same label as GENESIS. Both mean spec and plan are done, code is not.
  [STAGES.PLAN, 'planned'],
  [STAGES.GENESIS, 'planned'],
  [STAGES.ERGON, 'coded'],
  [STAGES.REVIEW, 'reviewed'],
  [STAGES.EPISTLE, 'pushed'],
  [STAGES.LYSIS, 'closed'],
  [STAGES.CANCEL, 'cancelled'],
]);

// Position first, then flags. This is what you scan in a ticket list.
export function describeTicket(ticket: Ticket): string {
  // Check cancelled first, or it would print as plain "closed".
  if (isCancelled(ticket)) return POSITIONS.get(STAGES.CANCEL) as string;

  if (isClosed(ticket)) return POSITIONS.get(STAGES.LYSIS) as string;

  const stage = currentStage(ticket);
  // An unknown stage prints as it is. No stage prints as `-`.
  const position = (stage && POSITIONS.get(stage)) ?? stage ?? '-';

  const flags: string[] = [];
  // Shows the real ending, like crashed or checks-failed.
  if (lastRunFailed(ticket)) flags.push(lastRunOutcome(ticket) as string);
  if (hasOpenPr(ticket)) flags.push('pr-open');
  return flags.length === 0 ? position : `${position}  [${flags.join(' ')}]`;
}
