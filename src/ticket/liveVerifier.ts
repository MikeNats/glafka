import { assertNoLiveRun } from './background.js';
import { ROLES } from '../types/ticket.js';

// Refuses while the QA tester runs. It tests the worktree as it is, so a change now
// makes its whole round untrusted, and a second round throws its results away.
export function assertNoLiveVerifier({
  stateDir,
  id,
  action,
  risk = 'the QA tester is checking the acceptance criteria in this worktree; a change now makes its round untrusted',
}: {
  stateDir: string;
  id: string;
  action: string;
  risk?: string;
}): void {
  assertNoLiveRun({ stateDir, id, role: ROLES.VERIFIER, action, risk });
}
