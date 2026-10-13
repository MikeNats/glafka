import { readTicket, updateTicket } from './store.js';
import { hashReviewToken } from './review.js';
import { specIds, VERIFY_RESULT } from './verification.js';
import type { CallerOrigin } from '../background.js';
import type { Verification, VerifyResult, VerifyResultKind } from '../../types/ticket.js';

const VERIFY_RESULT_VALUES = new Set<string>(Object.values(VERIFY_RESULT));

// Same two halves as krisis: the right token, from the right process.
function trusted(round: Verification, token: string | null, callerOrigin: CallerOrigin): boolean {
  if (round.token == null || hashReviewToken(token) !== round.token) return false;
  // A spawned round has a verifier to be inside. Once it exits, a copied token proves nothing.
  // A manual round, or an OS that cannot tell, keeps the krisis rule: not from outside.
  return round.spawned && process.platform !== 'win32'
    ? callerOrigin === 'inside'
    : callerOrigin !== 'outside';
}

export function appendVerifyResult(
  stateDir: string,
  id: string,
  {
    ac,
    result,
    evidence,
    token = null,
    callerOrigin = 'unanswerable',
  }: {
    ac: string;
    result: VerifyResultKind;
    evidence: string;
    token?: string | null;
    callerOrigin?: CallerOrigin;
  },
): Verification {
  if (!VERIFY_RESULT_VALUES.has(result)) {
    throw new Error(`unknown result "${result}" (expected pass, fail or cannot)`);
  }
  if (evidence.trim() === '') {
    throw new Error(
      `a result needs --evidence "<command> → <what came back>" — without it nobody can check the claim`,
    );
  }
  const before = readTicket(stateDir, id);
  if (!before.verification || before.verification.outcome !== null) {
    throw new Error(
      `ticket ${id} has no open verification round — start one with: glafka ergon ${id} --review`,
    );
  }
  const known = specIds(before);
  if (!known.includes(ac)) {
    throw new Error(
      `${ac} is not in this ticket's spec — its criteria are: ${known.join(', ') || 'none'}`,
    );
  }

  let added = false;
  const updated = updateTicket(stateDir, id, (ticket) => {
    const round = ticket.verification;
    if (!round || round.outcome !== null) return null;
    added = true;
    const entry: VerifyResult = {
      id: ac,
      result,
      evidence: evidence.trim(),
      at: new Date().toISOString(),
      verified: trusted(round, token, callerOrigin),
    };
    return { verification: { ...round, results: [...round.results, entry] } };
  });
  if (!added || !updated.verification) {
    throw new Error(
      `the verification round on ticket ${id} closed while this was recorded — it was not saved`,
    );
  }
  return updated.verification;
}
