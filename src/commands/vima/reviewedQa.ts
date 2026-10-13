import {
  lastReviewQaBlocked,
  lastStageAt,
  STAGES,
  VERIFY_OUTCOME,
} from '../../ticket/ticketStore.js';
import {
  verificationGap,
  reviewerStartedSinceRound,
  codeFor,
  codeChanges,
  roundCode,
} from '../epalitheusis/epalitheusis.js';
import type { Ticket, Verification } from '../../types/ticket.js';

export type ReviewedQa =
  { kind: 'review' } | { kind: 'needs-you'; reason: string } | { kind: 'verdict' };

// A plain `review` entry written after the round opened: a review was tried, and was not
// the QA round's own stop.
function reviewTriedSince(ticket: Ticket, round: Verification): boolean {
  const at = lastStageAt(ticket, STAGES.REVIEW);
  if (!at || !round.openedAt || lastReviewQaBlocked(ticket)) return false;
  return Date.parse(at) > Date.parse(round.openedAt);
}

const sameCode = (ticket: Ticket, round: Verification): boolean =>
  ticket.worktree != null &&
  codeChanges(roundCode(round), codeFor(round, ticket.worktree)).length === 0;

// What the QA round asks for on a ticket the stage log calls reviewed. 'review' goes through
// ergonReview, which closes or acts on the round once. vima starts no new QA tester from here.
export function reviewedQa(stateDir: string, ticket: Ticket): ReviewedQa {
  const round = ticket.verification;
  const started = reviewerStartedSinceRound(stateDir, ticket);
  // Retrying a review that started no reviewer would rerun the checks and ping every tick.
  if (round && !started && reviewTriedSince(ticket, round)) {
    const status = `glafka ergon ${ticket.id} --review --status`;
    return {
      kind: 'needs-you',
      reason: `no reviewer has started since this QA round — see ${status}`,
    };
  }
  // Open: ergonReview closes it. A live QA tester was already caught by the busy check.
  if (round && round.outcome === null) return { kind: 'review' };
  // Closed by a `--status` call and not acted on: act once, but only on the code it judged.
  const unused = round && !round.consumed && round.outcome !== VERIFY_OUTCOME.PASSED;
  if (unused && sameCode(ticket, round)) return { kind: 'review' };
  const gap = verificationGap(ticket);
  // A gap here waits for a person: the next QA round is theirs to start. That stops a paid loop.
  if (gap !== null) return { kind: 'needs-you', reason: `acceptance criteria: ${gap}` };
  // Nothing left to check, and no reviewer has read this code since the QA round: start one.
  return lastReviewQaBlocked(ticket) || !started ? { kind: 'review' } : { kind: 'verdict' };
}
