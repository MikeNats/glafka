import { updateTicket } from './store.js';
import type {
  Ticket,
  EthosCandidate,
  CandidateStatus,
  CandidateSource,
} from '../../types/ticket.js';

// A candidate is only a proposal. A human picks one of these.
export const CANDIDATE_STATUS = Object.freeze({
  PENDING: 'pending',
  KEPT: 'kept',
  DISCARDED: 'discarded',
});

// Who proposed it. `you` = your own call. `agent` = a guess, so check it.
export const CANDIDATE_SOURCE = Object.freeze({
  YOU: 'you',
  AGENT: 'agent',
});

// Always added as PENDING. A human must say yes before it becomes a rule.
export function appendEthosCandidate(
  stateDir: string,
  id: string,
  {
    target,
    text,
    source = CANDIDATE_SOURCE.AGENT,
  }: { target: string; text: string; source?: CandidateSource },
): EthosCandidate[] {
  if (!Object.values(CANDIDATE_SOURCE).includes(source)) {
    throw new Error(
      `unknown candidate source "${source}" (expected ${Object.values(CANDIDATE_SOURCE).join(' or ')})`,
    );
  }
  const updated = updateTicket(stateDir, id, (ticket) => ({
    ethosCandidates: [
      ...ticket.ethosCandidates,
      { status: CANDIDATE_STATUS.PENDING as CandidateStatus, target, source, text },
    ],
  }));
  return updated.ethosCandidates;
}

export function pendingCandidates(ticket: Pick<Ticket, 'ethosCandidates'>): EthosCandidate[] {
  return (ticket.ethosCandidates ?? []).filter((c) => c.status === CANDIDATE_STATUS.PENDING);
}

// Decides the ticket's pending candidates and returns the kept ones.
// keepIndexes start at 1, matching the numbers shown to the user.
export function decidePendingCandidates(
  stateDir: string,
  id: string,
  keepIndexes: number[],
): { kept: EthosCandidate[]; decided: number } {
  const keep = new Set(keepIndexes);
  let kept: EthosCandidate[] = [];
  let decided = 0;

  updateTicket(stateDir, id, (ticket) => {
    const pending = pendingCandidates(ticket);
    decided = pending.length;
    kept = [];
    let seen = 0;
    const ethosCandidates = ticket.ethosCandidates.map((candidate) => {
      if (candidate.status !== CANDIDATE_STATUS.PENDING) return candidate;
      seen += 1;
      const decision = {
        ...candidate,
        status: (keep.has(seen)
          ? CANDIDATE_STATUS.KEPT
          : CANDIDATE_STATUS.DISCARDED) as CandidateStatus,
      };
      if (decision.status === CANDIDATE_STATUS.KEPT) kept.push(decision);
      return decision;
    });
    return { ethosCandidates };
  });

  return { kept, decided };
}
