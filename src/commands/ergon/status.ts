import {
  readTicket,
  recordStage,
  readCachedChecks,
  saveCachedChecks,
  RUN_OUTCOMES,
  lastStageIndex,
  hasAporia,
  recordAporia,
  STAGES,
} from '../../ticket/ticketStore.js';
import {
  backgroundStatus,
  killBackground,
  hasPidFile,
  hasRecordedOutcome,
  markOutcomeRecorded,
} from '../../ticket/background.js';
import type { BackgroundStatus } from '../../ticket/background.js';
import { runChecks, checksVerdict } from '../../checks.js';
import { hostExecBlocking, resolvePolicy } from '../../../installKit/guardrails/index.js';
import { worktreeCheckKey, changedFiles } from '../../util/git.js';
import { OUTCOME_FOR_VERDICT, parseStuckFromLog, readProgress } from './utils.js';
import type { Progress } from './utils.js';
import type { Ticket } from '../../types/ticket.js';
import type { CheckResult } from '../../types/checks.js';

// Appends an `ergon` outcome unless a review has already happened since the last one. `--status` is
// printed by glafka's own output and gets run on every ticket; appending here after a clean round
// makes lastStageIndex(ERGON) newer than lastStageIndex(REVIEW), so isReviewedSinceLastChange flips
// to false, epistle refuses the push and vima buys a second review round of the SAME diff.
// Returns whether it wrote.
function recordErgonOutcome(stateDir: string, id: string, note: string): boolean {
  const ticket = readTicket(stateDir, id);
  if (lastStageIndex(ticket, STAGES.REVIEW) > lastStageIndex(ticket, STAGES.ERGON)) return false;
  recordStage(stateDir, id, STAGES.ERGON, note);
  return true;
}

// Reads the coder's `STUCK:` line off its own log and records it as an aporia, so a coder that
// could not run the CLI is not silently read as finished. It never overwrites an aporia the coder
// did manage to record: that one came through the command and is the better record of the two.
export function recordStuckFromLog({
  stateDir,
  id,
  ticket,
  status,
}: {
  stateDir: string;
  id: string;
  ticket: Ticket;
  status: BackgroundStatus;
}): string | null {
  if (hasAporia(ticket)) return null;
  const reason = parseStuckFromLog('logPath' in status ? status.logPath : null);
  if (!reason) return null;
  recordAporia(stateDir, id, reason);
  return reason;
}

export interface TicketStatus {
  ticket: Ticket;
  status: BackgroundStatus;
  checks: CheckResult[];
  progress: Progress | null;
  // Only set on the timed-out path. False means the run was NOT stopped and is
  // probably still going — see killBackground.
  killed?: boolean;
  // True when THIS call actually executed the checks and recorded a fresh outcome, rather than
  // reading a cached one. `--status` reads as a look, not an action, so the side effect was invisible
  // — and it is exactly the side effect `epistle`'s checks gate reads. Two identical-looking
  // `epistle` calls disagreeing was traced to this: something between them called `--status` (or
  // `checks`) on a ticket whose outcome had never been recorded, which recorded one, which flipped
  // the gate. The CLI prints this so the run that causes it is visible, not just its effect.
  justRan?: boolean;
}

// Runs the real checks instead of believing the agent. A failure here blocks
// review and push. A run longer than maxRuntimeMs is killed.
export async function ergonStatus({
  stateDir,
  id,
  repoRoot = null,
  baseRef = 'main',
  checksCmd = null,
  e2eCmd = null,
  checksTimeoutMs = null,
  e2eTimeoutMs = null,
  maxRuntimeMs = null,
  observability = false,
}: {
  stateDir: string;
  id: string;
  // Needed only to tell whether package.json was touched by this branch. Without it (older callers, or tests with nothing to diff against) the
  repoRoot?: string | null;
  baseRef?: string;
  checksCmd?: string | null;
  e2eCmd?: string | null;
  checksTimeoutMs?: number | null;
  e2eTimeoutMs?: number | null;
  maxRuntimeMs?: number | null;
  // Default false so a caller not yet updated records nothing.
  observability?: boolean;
}): Promise<TicketStatus> {
  const ticket = readTicket(stateDir, id);
  const status = backgroundStatus({ stateDir, id, maxRuntimeMs });
  const progress = readProgress(ticket, baseRef);

  if (status.state === 'timed-out') {
    // Reported, not assumed. A kill that did not land leaves the run spending
    // money, and the caller prints "killed" off this value.
    // byUser:false — this run ran out of time, nobody chose to stop it.
    const killed = killBackground({ stateDir, id, byUser: false });
    // Marks this run as timed out. lastRunFailed() reads this. Nothing was killed and nothing was spawned
    // by us: recording "timed out" for a run glafka never controlled is a false statement in an append-only log.
    if (killed || hasPidFile({ stateDir, id })) {
      recordErgonOutcome(stateDir, id, RUN_OUTCOMES.TIMED_OUT);
    }
    return { ticket: readTicket(stateDir, id), status, checks: [], progress, killed };
  }

  if (status.state === 'finished') {
    if (!ticket.worktree) {
      throw new Error(`ticket ${id} finished but has no worktree — nothing to check`);
    }
    // A coder that could not reach `glafka aporia` says so in its own output instead. Recorded here,
    // once, so the ticket stops reading as "finished".
    recordStuckFromLog({ stateDir, id, ticket, status });
    // The key ties results to this commit, so review can reuse them.
    // A null key means do not trust it and do not save it.
    const key = worktreeCheckKey(ticket.worktree, { checksCmd, e2eCmd });
    const cached = readCachedChecks(ticket, key);
    // See ergonReview's own comment: package.json's scripts must not run
    // on the host, unattended, when this branch's own diff touched it.
    const changedForChecks = repoRoot ? changedFiles(ticket.worktree, baseRef) : [];
    const untrustedPackageJson = changedForChecks.includes('package.json');
    // The same list hostexec already flags at review and push time — but here
    // it BLOCKS, because runChecks executes on the host outside every cage.
    const hostExecutingChanges = repoRoot
      ? hostExecBlocking(resolvePolicy({ repoRoot }).policy, changedForChecks)
      : [];
    const checks =
      cached ??
      (await runChecks(ticket.worktree, {
        checksCmd,
        e2eCmd,
        checksTimeoutMs,
        e2eTimeoutMs,
        untrustedPackageJson,
        hostExecutingChanges,
      }));
    if (!cached) saveCachedChecks(stateDir, id, key, checks);
    // Save the ending only once. `--status` can be asked many times, and
    // writing again would undo a review that happened in between.
    let justRecorded = false;
    if (!hasRecordedOutcome({ stateDir, id })) {
      // An empty list means nothing ran. That is not a pass.
      if (recordErgonOutcome(stateDir, id, OUTCOME_FOR_VERDICT[checksVerdict(checks)])) {
        markOutcomeRecorded({ stateDir, id, observability });
        justRecorded = true;
      }
    }
    return {
      ticket: readTicket(stateDir, id),
      status,
      checks,
      progress,
      justRan: !cached || justRecorded,
    };
  }

  if (status.state === 'failed' || status.state === 'crashed' || status.state === 'cancelled') {
    // Guarded like the branch above, for the same reason. An extra entry
    // here would quietly undo a review you did by hand.
    if (!hasRecordedOutcome({ stateDir, id })) {
      const outcome = status.state === 'cancelled' ? RUN_OUTCOMES.CANCELLED : RUN_OUTCOMES.CRASHED;
      if (recordErgonOutcome(stateDir, id, outcome)) {
        markOutcomeRecorded({ stateDir, id, observability });
      }
    }
    return { ticket: readTicket(stateDir, id), status, checks: [], progress };
  }

  return { ticket, status, checks: [], progress };
}
