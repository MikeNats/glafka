import { updateTicket } from './store.js';
import { hashReviewToken } from './review.js';
import { parseCriteria } from '../criteria.js';
import type { Criterion } from '../criteria.js';
import type { Ticket } from '../../types/ticket.js';

// --------------------------------------------------------------------------- QA rounds — epalitheusis

export const VERIFY_RESULT = Object.freeze({ PASS: 'pass', FAIL: 'fail', CANNOT: 'cannot' });

export const VERIFY_OUTCOME = Object.freeze({
  PASSED: 'passed',
  FAILED: 'failed',
  CANNOT: 'cannot',
  UNTRUSTED: 'untrusted',
  INCOMPLETE: 'incomplete',
});

// The criteria still to check: the spec's, minus the ones a person skipped.
export function activeCriteria(ticket: Ticket): Criterion[] {
  const skipped = new Set((ticket.criteriaSkips ?? []).map((s) => s.id));
  return parseCriteria(ticket.specText).criteria.filter((c) => !skipped.has(c.id));
}

export function specIds(ticket: Ticket): string[] {
  return parseCriteria(ticket.specText).criteria.map((c) => c.id);
}

// One line: the detail holds the QA tester's own evidence, which may span lines.
export const aporiaReason = (detail: string | null): string =>
  `epalitheusis: ${(detail ?? '').replace(/\s*[\r\n]+\s*/g, ' ')}`;

// True while the ticket's aporia is still the one this round set, not a newer one.
export function roundOwnsAporia(ticket: Ticket): boolean {
  const round = ticket.verification;
  if (!round?.aporiaAt || !ticket.aporia) return false;
  return ticket.aporia.at === round.aporiaAt && ticket.aporia.reason === aporiaReason(round.detail);
}

// Starts a new round and replaces the old one. An aporia the old round set goes with it.
export function openVerifyRound(
  stateDir: string,
  id: string,
  {
    token,
    tree,
    dirty,
    spawned,
    checkMade = [],
  }: { token: string; tree: string; dirty: string[]; spawned: boolean; checkMade?: string[] },
): Ticket {
  return updateTicket(stateDir, id, (ticket) => ({
    verification: {
      token: hashReviewToken(token),
      tree,
      dirty: [...dirty],
      checkMade: [...checkMade],
      closedCode: null,
      openedAt: new Date().toISOString(),
      spawned,
      results: [],
      outcome: null,
      detail: null,
      consumed: false,
      aporiaAt: null,
    },
    ...(roundOwnsAporia(ticket) ? { aporia: null } : {}),
  }));
}
