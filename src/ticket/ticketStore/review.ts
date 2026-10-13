import crypto from 'node:crypto';
import { updateTicket } from './store.js';
import { STAGES } from './stages.js';
import { runRolesOnDisk } from '../paths.js';
import type { CallerOrigin } from '../background.js';
import type { Ticket, ReviewVerdict, ReviewFinding } from '../../types/ticket.js';

// --------------------------------------------------------------------------- Review findings — what a fresh reviewer decided. Only added, never edited,

export const REVIEW_VERDICT = Object.freeze({
  CLEAN: 'clean',
  BLOCKING: 'blocking',
});

const REVIEW_VERDICT_VALUES = new Set(Object.values(REVIEW_VERDICT));

// One call = one verdict, plus one finding if there is one. A blocking verdict with no finding is refused, since nobody could act on it.
export function appendReviewFinding(
  stateDir: string,
  id: string,
  {
    verdict,
    finding = null,
    token = null,
    // Whether this call came from inside a live reviewer's own process group. 'outside' means a
    // token that matches is still NOT trusted: the string was carried somewhere it could not have
    // been used from, which is exactly the copied-token case the token alone cannot catch.
    // 'unanswerable' keeps the old behaviour — the manual review path has no
    // reviewer process to belong to, and it must stay usable.
    callerOrigin = 'unanswerable',
  }: {
    verdict: ReviewVerdict;
    finding?: string | null;
    token?: string | null;
    callerOrigin?: CallerOrigin;
  },
): ReviewFinding[] {
  if (!REVIEW_VERDICT_VALUES.has(verdict)) {
    throw new Error(
      `unknown review verdict "${verdict}" (expected ${[...REVIEW_VERDICT_VALUES].join(' or ')})`,
    );
  }
  if (verdict === REVIEW_VERDICT.BLOCKING && !finding) {
    throw new Error(
      `a blocking verdict needs --finding "<file:line — what's wrong>" — ` +
        `without it there is nothing on the ticket to act on`,
    );
  }
  // The reviewer can send many calls at once. The lock in updateTicket
  // covers the read too, so none of these get lost.
  const updated = updateTicket(stateDir, id, (ticket) => {
    const entry: ReviewFinding = {
      verdict,
      finding,
      at: new Date().toISOString(),
      // No token on the ticket means no review round was ever started for it — that is NOT the same as
      // "trust this call", since the coder Both halves are required: the right token AND a place it could legitimately have been used from.
      verified:
        ticket.reviewToken != null &&
        hashReviewToken(token) === ticket.reviewToken &&
        callerOrigin !== 'outside',
    };
    return { reviewFindings: [...(ticket.reviewFindings ?? []), entry] };
  });
  return updated.reviewFindings;
}

// The ticket stores a HASH, never the token. The plaintext exists only in prepareReview's return
// value and in the reviewer's own prompt, so reading the ticket file buys nothing — which matters
// because the ticket lives in `.glafka/`, and a doorman denying that path is not what should have
// been stopping this.
export function hashReviewToken(token: string | null): string | null {
  if (token == null || token === '') return null;
  return crypto.createHash('sha256').update(token).digest('hex');
}

// A new token per round, set right after the old findings are cleared,
// so a token from the last round can not pass here.
export function setReviewToken(stateDir: string, id: string, token: string): void {
  updateTicket(stateDir, id, () => ({ reviewToken: hashReviewToken(token) }));
}

export function reviewFindings(ticket: Ticket): ReviewFinding[] {
  return ticket.reviewFindings ?? [];
}

export function hasBlockingFindings(ticket: Ticket): boolean {
  return reviewFindings(ticket).some((f) => f.verdict === REVIEW_VERDICT.BLOCKING);
}

// Clears the slate for a new review round. Without this, an old blocking
// finding would stay and make a clean review still look blocked.
export function clearReviewFindings(stateDir: string, id: string): void {
  // The dispatched roles belong to the round too. Leaving last round's list
  // behind would make the new round wait on a reviewer it never started.
  updateTicket(stateDir, id, () => ({ reviewFindings: [], reviewerRoles: [] }));
}

// Records which reviewer roles this round started, at dispatch time.
export function setReviewerRoles(stateDir: string, id: string, roles: string[]): void {
  updateTicket(stateDir, id, () => ({ reviewerRoles: [...roles] }));
}

// The roles this round dispatched. An empty list means the rounds that ran
// before fan-out existed, so it reads as the single "reviewer" role.
export function reviewerRoles(ticket: Ticket): string[] {
  return ticket.reviewerRoles && ticket.reviewerRoles.length > 0
    ? ticket.reviewerRoles
    : ['reviewer'];
}

// Names a run directory has to start with to count as a reviewer. "coder" is swept up by the same
// walk and is guarded separately, so it is excluded here rather than being checked twice.
const REVIEWER_ROLE_PREFIX = 'reviewer';

// What a liveness guard must check: the roles the ticket recorded, PLUS every `reviewer*` run
// folder actually on disk. Reading only the ticket trusts a write that may not have happened — a
// reviewer that is running but missing from the list is invisible to every guard, and the worktree
// gets deleted under it. Reading only the disk would drop the implicit "reviewer"
// default for pre-fan-out tickets. The union is the safe set: a role that is not really running
// reads as `not-started`, which every guard already lets through, so a false entry here costs
// nothing and a missing one loses a verdict.
export function liveReviewerRoles({
  stateDir,
  id,
  ticket,
}: {
  stateDir: string;
  id: string;
  ticket: Ticket;
}): string[] {
  const swept = runRolesOnDisk(stateDir, id).filter((role) =>
    role.startsWith(REVIEWER_ROLE_PREFIX),
  );
  return [...new Set([...reviewerRoles(ticket), ...swept])];
}

// How many times review has run, counted from the log. This stops an unwatched fix loop from
// running forever. How many review rounds have been SPENT, which is not the same as how many
// happened. A round only counts if the coder ran again since the previous one — a re-review of
// unchanged code took a try away from the human for nothing, and that mattered more once a diff
// could earn several reviewers and so collect several times the findings. It reads the append-only
// log, so it needs no git call and no new field. What it means precisely: "the coder ran again",
// not "a commit landed". A coder that ran and produced nothing still consumes a round. Tightening
// that further needs a per-round commit count saved on the ticket; do it only if real tickets show
// it mattering.
export function reviewRoundCount(ticket: Ticket): number {
  let spent = 0;
  let coderRanSince = true; // the first review always follows the first ergon
  for (const entry of ticket.stageLog ?? []) {
    if (entry.stage === STAGES.ERGON) {
      coderRanSince = true;
      continue;
    }
    if (entry.stage !== STAGES.REVIEW) continue;
    if (coderRanSince) spent += 1;
    coderRanSince = false;
  }
  return spent;
}
