import { activeCriteria, lastRunFailed, wasNotified } from '../../ticket/ticketStore.js';
import { resolveAgentCmd } from '../../config.js';
import { ROLES } from '../../types/ticket.js';
import { verifyGate } from '../epalitheusis/epalitheusis.js';
import type { VimaConfig } from './utils.js';
import type { Ticket } from '../../types/ticket.js';

const verifyByHand = (id: string): string =>
  `no verifier agent configured — verify manually: glafka ergon ${id} --review at a real terminal — needs you`;

// The tick that ran the checks may say they passed. A waiting tick ran none, so it does not.
export const noVerifierReason = (id: string): string => `checks green, but ${verifyByHand(id)}`;
export const waitingReason = (id: string): string =>
  `acceptance criteria wait for a QA tester: ${verifyByHand(id)}`;

// The QA round is next, and no agent can run it. Once a person was told, running the
// checks again every tick only says the same thing again.
export function waitsForVerifierAgent({
  stateDir,
  ticket,
  config,
}: {
  stateDir: string;
  ticket: Ticket;
  config: VimaConfig;
}): boolean {
  if (!wasNotified(ticket) || lastRunFailed(ticket)) return false;
  if (activeCriteria(ticket).length === 0) return false;
  if (resolveAgentCmd({ config, role: ROLES.VERIFIER })) return false;
  return verifyGate({ stateDir, id: ticket.id }).kind === 'start';
}
