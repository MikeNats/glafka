import { updateTicket } from './store.js';
import type { Ticket, Aporia } from '../../types/ticket.js';
import type { CheckResult } from '../../types/checks.js';

// --------------------------------------------------------------------------- Aporia means the coder is stuck. It must say so and stop, not guess.
export function recordAporia(stateDir: string, id: string, reason: string): void {
  updateTicket(stateDir, id, () => ({ aporia: { reason, at: new Date().toISOString() } }));
}

// Cleared at the start of every new try, or a coder that got past
// the old block would still look stuck on it.
export function clearAporia(stateDir: string, id: string): void {
  updateTicket(stateDir, id, (ticket) => (ticket.aporia ? { aporia: null } : null));
}

export function hasAporia(ticket: Ticket): ticket is Ticket & { aporia: Aporia } {
  return Boolean(ticket.aporia);
}

// --------------------------------------------------------------------------- Notify once per state, not once per tick. Cleared when aporia is cleared,

export function markNotified(stateDir: string, id: string): void {
  updateTicket(stateDir, id, (ticket) => (ticket.notified ? null : { notified: true }));
}

export function clearNotified(stateDir: string, id: string): void {
  updateTicket(stateDir, id, (ticket) => (ticket.notified ? { notified: false } : null));
}

export function wasNotified(ticket: Ticket): boolean {
  return Boolean(ticket.notified);
}

// --------------------------------------------------------------------------- Saved check results

// Reuse old results if the worktree did not change, so we do not run
// the checks twice. A null key never matches, so unsure means run again.
export function readCachedChecks(ticket: Ticket, key: string | null): CheckResult[] | null {
  if (key === null || !ticket.checks) return null;
  return ticket.checks.key === key ? ticket.checks.results : null;
}

export function saveCachedChecks(
  stateDir: string,
  id: string,
  key: string | null,
  results: CheckResult[],
): void {
  if (key === null) return;
  updateTicket(stateDir, id, () => ({ checks: { key, results } }));
}
