import { activeCriteria, VERIFY_OUTCOME } from '../../ticket/ticketStore.js';
import { codeFor, codeChanges, roundCode } from './codeState.js';
import type { Ticket } from '../../types/ticket.js';

// A push sends only commits, and a reviewer reads only commits.
export function uncommittedPassReason(dirty: string[]): string {
  const files = dirty.map((line) => line.trim()).join(', ');
  return `the criteria passed on uncommitted changes (${files}) — commit them, or gitignore/delete them if they are generated, then verify again`;
}

// For epistle: why this code is not verified yet, or null when nothing is left to check.
export function verificationGap(ticket: Ticket): string | null {
  const criteria = activeCriteria(ticket);
  if (criteria.length === 0) return null;
  const round = ticket.verification;
  if (!round) return `${criteria.map((c) => c.id).join(', ')} never verified`;
  if (round.outcome === null) return 'a verification round is still open';
  if (round.outcome !== VERIFY_OUTCOME.PASSED) {
    return `the last verification round ended ${round.outcome}: ${round.detail ?? ''}`;
  }
  if (!ticket.worktree) return null;
  const code = roundCode(round);
  const changes = codeChanges(code, codeFor(round, ticket.worktree));
  if (changes.length > 0)
    return `the code changed after the criteria passed: ${changes.join(', ')}`;
  return code.dirty.length > 0 ? uncommittedPassReason(code.dirty) : null;
}
