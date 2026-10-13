import { REVIEW_VERDICT } from '../../ticket/ticketStore.js';
import type { ReviewVerdict } from '../../types/ticket.js';
import { ergonReviewStatus, VERDICT_SOURCE } from '../ergon/ergon.js';

export type PushVerdict =
  | { source: typeof VERDICT_SOURCE.NOT_DONE; verdict: null }
  | { source: typeof VERDICT_SOURCE.RUN_FAILED; verdict: null }
  | { source: typeof VERDICT_SOURCE.NONE; verdict: null }
  | { source: typeof VERDICT_SOURCE.KRISIS; verdict: ReviewVerdict; finding: string | null }
  | { source: typeof VERDICT_SOURCE.LOG_LINE; verdict: ReviewVerdict; finding: string | null };

// A review entry only proves a round was set up, not that anyone read the diff. So we look at the real verdict instead.
export function resolvePushVerdict({
  stateDir,
  id,
}: {
  stateDir: string;
  id: string;
}): PushVerdict {
  const { status, findings, verdict } = ergonReviewStatus({ stateDir, id });

  // An early "blocking" always counts, even mid-run.
  // An early "clean" does not.
  const blocking = findings.find((f) => f.verdict === REVIEW_VERDICT.BLOCKING);
  if (blocking) {
    return {
      source: VERDICT_SOURCE.KRISIS,
      verdict: REVIEW_VERDICT.BLOCKING,
      finding: blocking.finding,
    };
  }
  // The documented foreground path (no separate reviewer configured) never touches backgroundStatus at all, so a real, human-read "clean" here can
  if (
    verdict.source === VERDICT_SOURCE.NOT_DONE &&
    status.state === 'not-started' &&
    findings.some((f) => f.verified)
  ) {
    return { source: VERDICT_SOURCE.KRISIS, verdict: REVIEW_VERDICT.CLEAN, finding: null };
  }
  // That shape carries no finding, so we add an empty one here.
  // This keeps the type below simple.
  if (verdict.source === VERDICT_SOURCE.KRISIS) {
    return { source: VERDICT_SOURCE.KRISIS, verdict: verdict.verdict, finding: null };
  }
  return verdict;
}
