// Pure: no git and no files. The store judges a round with it under the ticket lock.
import { VERIFY_OUTCOME, VERIFY_RESULT } from './ticketStore/verification.js';
import type { Criterion } from './criteria.js';
import type { VerifyResult, VerifyOutcome } from '../types/ticket.js';

// The newest result per AC. A verifier may record the same AC twice.
export function latestById(results: VerifyResult[]): Map<string, VerifyResult> {
  return new Map(results.map((result) => [result.id, result]));
}

const describe = (what: string, results: VerifyResult[]): string =>
  results.map((r) => `${r.id} ${what}: ${r.evidence}`).join('; ');

// How a round ended. The first rule that matches wins.
export function roundOutcome({
  criteria,
  results,
  changes,
}: {
  criteria: Criterion[];
  results: VerifyResult[];
  changes: string[];
}): { outcome: VerifyOutcome; detail: string } {
  if (changes.length > 0) {
    return {
      outcome: VERIFY_OUTCOME.UNTRUSTED,
      detail: `the code changed during the round: ${changes.join(', ')}`,
    };
  }
  const latest = latestById(results);
  const missing = criteria.filter((c) => !latest.has(c.id)).map((c) => c.id);
  if (missing.length > 0) {
    return { outcome: VERIFY_OUTCOME.INCOMPLETE, detail: `no result for ${missing.join(', ')}` };
  }
  const own = criteria.map((c) => latest.get(c.id)!);
  const cannot = own.filter((r) => r.result === VERIFY_RESULT.CANNOT);
  if (cannot.length > 0)
    return { outcome: VERIFY_OUTCOME.CANNOT, detail: describe('cannot be checked', cannot) };
  const failed = own.filter((r) => r.result === VERIFY_RESULT.FAIL);
  if (failed.length > 0)
    return { outcome: VERIFY_OUTCOME.FAILED, detail: describe('failed', failed) };
  const untrusted = own.filter((r) => !r.verified);
  if (untrusted.length > 0) {
    return {
      outcome: VERIFY_OUTCOME.UNTRUSTED,
      detail: `${untrusted.map((r) => r.id).join(', ')} passed without this round's token — not trusted`,
    };
  }
  return {
    outcome: VERIFY_OUTCOME.PASSED,
    detail: `all ${criteria.length} acceptance criteria passed`,
  };
}
