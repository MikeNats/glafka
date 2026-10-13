import {
  backgroundStatus,
  hasRecordedOutcome,
  markOutcomeRecorded,
  reapOrphans,
} from '../../ticket/background.js';
import { ROLES } from '../../types/ticket.js';

// A QA tester run in any of these has stopped, so its cost is final.
const ENDED_STATES = new Set(['finished', 'failed', 'crashed', 'cancelled']);

// Once a QA tester run has ended: record it in the audit once, and stop what it left running.
// The same two steps a reviewer gets in ergonReviewStatus.
export function settleVerifierRun({
  stateDir,
  id,
  observability,
}: {
  stateDir: string;
  id: string;
  observability: boolean;
}): void {
  const role = ROLES.VERIFIER;
  if (!ENDED_STATES.has(backgroundStatus({ stateDir, id, role }).state)) return;
  if (observability && !hasRecordedOutcome({ stateDir, id, role })) {
    markOutcomeRecorded({ stateDir, id, role, observability });
  }
  reapOrphans({ stateDir, id, role });
}
