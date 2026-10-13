import { readTicket, updateTicket } from './store.js';
import { specIds, activeCriteria, roundOwnsAporia, VERIFY_OUTCOME } from './verification.js';
import { roundOutcome } from '../roundOutcome.js';
import type { Ticket, Verification } from '../../types/ticket.js';

// A skip reason is one line: it is written to the decisions file as one.
export const skipReasonLine = (reason: string): string => reason.replace(/\s+/g, ' ').trim();

// Outcomes a skip can change: the skipped AC may be the only reason the round did not pass.
const REJUDGED = new Set<string>([
  VERIFY_OUTCOME.FAILED,
  VERIFY_OUTCOME.CANNOT,
  VERIFY_OUTCOME.INCOMPLETE,
]);

// The closed round, judged again on the AC left. Same code: the gate checks that later.
// Still not passed → used up, so the next round re-checks without the skipped AC.
function afterSkip(round: Verification, ticket: Ticket): Verification {
  const verdict = REJUDGED.has(round.outcome ?? '')
    ? roundOutcome({ criteria: activeCriteria(ticket), results: round.results, changes: [] })
    : null;
  if (verdict?.outcome === VERIFY_OUTCOME.PASSED) {
    return { ...round, outcome: verdict.outcome, detail: verdict.detail, aporiaAt: null };
  }
  return { ...round, consumed: true, aporiaAt: null };
}

// A person skips one criterion.
export function addCriterionSkip(
  stateDir: string,
  id: string,
  { ac, reason }: { ac: string; reason: string },
): void {
  const line = skipReasonLine(reason);
  if (line === '')
    throw new Error(`a skip needs a reason — it is written to the ticket's decisions`);
  const ticket = readTicket(stateDir, id);
  const known = specIds(ticket);
  if (!known.includes(ac)) {
    throw new Error(
      `${ac} is not in this ticket's spec — its criteria are: ${known.join(', ') || 'none'}`,
    );
  }
  if ((ticket.criteriaSkips ?? []).some((s) => s.id === ac)) {
    throw new Error(`${ac} is already skipped on ticket ${id}`);
  }
  updateTicket(stateDir, id, (current) => {
    const round = current.verification;
    const skip = { id: ac, reason: line, at: new Date().toISOString() };
    const criteriaSkips = [...(current.criteriaSkips ?? []), skip];
    const closedNotPassed =
      round && round.outcome !== null && round.outcome !== VERIFY_OUTCOME.PASSED;
    return {
      criteriaSkips,
      ...(closedNotPassed ? { verification: afterSkip(round, { ...current, criteriaSkips }) } : {}),
      ...(roundOwnsAporia(current) ? { aporia: null } : {}),
    };
  });
}
