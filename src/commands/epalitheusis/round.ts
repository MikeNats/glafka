import { readTicket, activeCriteria, VERIFY_OUTCOME } from '../../ticket/ticketStore.js';
import { codeFor, codeChanges, roundCode } from './codeState.js';
import { latestById } from './outcome.js';
import { closeRoundIfEnded } from './closeIfEnded.js';
import { uncommittedPassReason } from './verificationGap.js';
import type { Criterion } from '../../ticket/criteria.js';
import type { VerifyOutcome } from '../../types/ticket.js';

export type VerifyGate =
  | { kind: 'skip' }
  | { kind: 'passed'; justClosed: boolean }
  | { kind: 'running'; missing: string[] }
  | { kind: 'start'; criteria: Criterion[] }
  // `tokenHash` names the round this answer is about, so only that round is used up.
  | { kind: 'blocked'; outcome: VerifyOutcome; detail: string; tokenHash: string | null };

// What to do about the acceptance criteria now. The CLI, vima and prepareReview all ask this.
export function verifyGate({
  stateDir,
  id,
  maxRuntimeMs = null,
}: {
  stateDir: string;
  id: string;
  maxRuntimeMs?: number | null;
}): VerifyGate {
  const justClosed = closeRoundIfEnded({ stateDir, id, maxRuntimeMs });
  const ticket = readTicket(stateDir, id);
  const criteria = activeCriteria(ticket);
  if (criteria.length === 0) return { kind: 'skip' };
  const round = ticket.verification;
  if (!round || !ticket.worktree) return { kind: 'start', criteria };
  if (round.outcome === null) {
    const latest = latestById(round.results);
    return { kind: 'running', missing: criteria.filter((c) => !latest.has(c.id)).map((c) => c.id) };
  }
  // Measured against the code at the CLOSE: a round made untrusted by a change must not
  // restart for free. A round this call just closed was judged on the code it just read.
  const code = roundCode(round);
  const now = codeFor(round, ticket.worktree);
  const sameCode = justClosed || codeChanges(code, now).length === 0;
  // A pass on uncommitted files says nothing about the commits a reviewer reads.
  const dirtyPass = round.outcome === VERIFY_OUTCOME.PASSED && code.dirty.length > 0;
  if (sameCode && round.outcome === VERIFY_OUTCOME.PASSED && !dirtyPass) {
    return { kind: 'passed', justClosed };
  }
  // A fail nobody acted on stays locked while the committed tree is the same: a stray file
  // must not throw it away. A committed fix starts the next round at once.
  const unusedFail =
    round.outcome === VERIFY_OUTCOME.FAILED && (justClosed || code.tree === now.tree);
  if (!round.consumed && (sameCode || unusedFail)) {
    const detail = dirtyPass ? uncommittedPassReason(code.dirty) : (round.detail ?? '');
    return { kind: 'blocked', outcome: round.outcome, detail, tokenHash: round.token };
  }
  return { kind: 'start', criteria };
}
