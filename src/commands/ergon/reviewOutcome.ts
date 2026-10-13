import {
  readTicket,
  reviewerRoles,
  reviewFindings,
  decidePendingCandidates,
} from '../../ticket/ticketStore.js';
import {
  backgroundStatus,
  killBackground,
  hasRecordedOutcome,
  markOutcomeRecorded,
  reapOrphans,
} from '../../ticket/background.js';
import type { BackgroundStatus } from '../../ticket/background.js';
import { resolveKeep } from '../../memory/ethosGate.js';
import { promoteEthosCandidates } from '../../memory/ethos.js';
import { resolveVerdict, resolveRoundVerdict } from './utils.js';
import type { Ticket, ReviewFinding } from '../../types/ticket.js';

export interface ReviewStatus {
  ticket: Ticket;
  // The FIRST reviewer's run. Kept because everything written before
  // fan-out reads this, and with one reviewer it is the whole story.
  status: BackgroundStatus;
  // Every reviewer this round dispatched, in dispatch order. `killed` is null
  // unless the run timed out; false there means it was not stopped.
  runs: { role: string; status: BackgroundStatus; killed: boolean | null }[];
  // How many have finished, out of how many started. For "2 of 3 back".
  back: number;
  total: number;
  findings: ReviewFinding[];
  verdict: ReturnType<typeof resolveVerdict>;
}

// A reviewer that reached any of these has stopped, so its cost is final.
// `cancelled` belongs here too: a run someone killed is as stopped as one
// that died, and only the reason differs.
const ENDED_STATES = new Set(['finished', 'failed', 'crashed', 'cancelled', 'timed-out']);

// Checks on a running reviewer, with the same time limit as the coder.
// It leaves the review note alone, because that says something else.
export function ergonReviewStatus({
  stateDir,
  id,
  maxRuntimeMs = null,
  observability = false,
}: {
  stateDir: string;
  id: string;
  maxRuntimeMs?: number | null;
  // Reviewers are spawned in the background, and their outcome is observed
  // here and nowhere else — so this is the only place they can be recorded.
  observability?: boolean;
}): ReviewStatus {
  // Which reviewers this round actually started. On a ticket from before fan-out this is the single
  // "reviewer" role, so nothing changes. The recorded list on purpose, NOT the disk sweep
  // `liveReviewerRoles` does. The guards union in stray `reviewer*` folders because a false entry
  // there is free — it reads as `not-started` and lets them through. Here it is not free: a
  // leftover folder from an earlier round would read as a reviewer this round is still waiting on,
  // and hold the round open for good.
  const roles = reviewerRoles(readTicket(stateDir, id));

  const runs = roles.map((role) => {
    const status = backgroundStatus({ stateDir, id, role, maxRuntimeMs });
    // A reviewer past its limit is killed, same as before — once per role, or a hung second reviewer
    // would hold the round open forever. Whether the kill landed is carried out, not assumed.
    const killed =
      status.state === 'timed-out'
        ? // byUser:false — the limit ended this, not a person.
          killBackground({ stateDir, id, role, byUser: false })
        : null;
    // Once per role. `--status` can be asked many times, and each ask would
    // otherwise append the same run again.
    //
    // `observability` is checked FIRST because markOutcomeRecorded writes the
    // marker whether or not it records. A read-only caller like poreia has no
    // config, so without this it burned the marker and the run was lost.
    if (
      observability &&
      ENDED_STATES.has(status.state) &&
      !hasRecordedOutcome({ stateDir, id, role })
    ) {
      markOutcomeRecorded({ stateDir, id, role, observability });
    }
    // Unconditional on `observability` — a leftover OS process is not an audit-trail concern, and
    // `reapOrphans` gates itself with its own marker, so this costs nothing on every call after the
    // first. The "coder reports done, reviewer OS process keeps running" case: caught the first time
    // anything asks about this role again after it finished.
    if (ENDED_STATES.has(status.state)) reapOrphans({ stateDir, id, role });
    return { role, status, killed };
  });

  // Read AFTER the runs, so a verdict recorded while we looked is included.
  const ticket = readTicket(stateDir, id);
  const findings = reviewFindings(ticket);
  const statuses = runs.map((r) => r.status);
  const notDone = new Set(['not-started', 'running', 'stalled', 'timed-out']);

  return {
    ticket,
    status: statuses[0]!,
    runs,
    back: statuses.filter((s) => !notDone.has(s.state)).length,
    total: statuses.length,
    findings,
    verdict: resolveRoundVerdict({ statuses, findings }),
  };
}

// A human picks which findings to keep. Kept separate, so an agent
// can never approve its own review.
export function ergonReviewDecide({
  repoRoot,
  stateDir,
  id,
  keep,
}: {
  repoRoot: string;
  stateDir: string;
  id: string;
  keep?: string | null;
}) {
  const ticket = readTicket(stateDir, id);
  const { pending, keepIndexes } = resolveKeep({ ticket, keep, command: 'ergon --review' });
  if (pending.length === 0) return { ticket, kept: [], decided: 0 };

  // Promote first, decide (write the ticket) second — same reasoning as lysis.ts's own fix: a promote failure after the ticket already says
  const toPromote = pending.filter((_candidate, i) => keepIndexes.includes(i + 1));
  promoteEthosCandidates(repoRoot, toPromote);

  const { kept, decided } = decidePendingCandidates(stateDir, id, keepIndexes);
  return { ticket, kept, decided };
}
