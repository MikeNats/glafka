import {
  readTicket,
  listTickets,
  isClosed,
  isCancelled,
  hasAporia,
  isReviewedSinceLastChange,
  hasUnreviewedCommit,
  UNREVIEWED_COMMIT,
  reviewRoundCount,
  liveReviewerRoles,
  setReviewerRoles,
  recordStage,
  markNotified,
  lastReviewQaBlocked,
  VERIFY_OUTCOME,
  STAGES,
  RUN_OUTCOMES,
} from '../../ticket/ticketStore.js';
import {
  backgroundStatus,
  backgroundPid,
  killBackground,
  hasRecordedOutcome,
  markOutcomeRecorded,
  reapOrphans,
  RUNNING_STATES,
} from '../../ticket/background.js';
import { resolveAgentCmd } from '../../config.js';
import { ROLES } from '../../types/ticket.js';
import { resolvePolicy } from '../../../installKit/guardrails/index.js';
import {
  ergonReview,
  dispatchReviewer,
  recordStuckFromLog,
  ergonReviewStatus,
  VERDICT_SOURCE,
  CoderFixableError,
  PreExistingChecksError,
  NothingToReviewError,
} from '../ergon/ergon.js';
import { ensureDevServer, reportDevServer, ticketPorts } from '../../ticket/resources.js';
import type { DevServerOutcome } from '../../ticket/resources.js';
import { stopDevServerAndWait } from '../../ticket/devServer.js';
import {
  dispatchVerifier,
  settleVerifierRun,
  strictLevelWarning,
  verifyGate,
  verificationGap,
  codeChanges,
  codeFor,
  roundCode,
} from '../epalitheusis/epalitheusis.js';
import { waitsForVerifierAgent, noVerifierReason, waitingReason } from './noVerifier.js';
import { spawnCoder, notifyOnce, wakeServicesOrStop } from './utils.js';
import type { VimaResult, VimaConfig } from './utils.js';
import type { Ticket } from '../../types/ticket.js';

// How long one tick waits for an app to come up. Far below the full timeout on
// purpose: a tick sweeps every open ticket, and it runs them one after another.
export const TICK_READY_TIMEOUT_MS = 10_000;

// One step. It moves a ticket forward by a single action, and it is safe to
// call again. It never pushes and never closes. That stays your job.
export async function vima({
  stateDir,
  id,
  repoRoot,
  config,
}: {
  stateDir: string;
  id: string;
  repoRoot: string;
  config: VimaConfig;
}): Promise<VimaResult> {
  const ticket = readTicket(stateDir, id);

  if (isCancelled(ticket)) return { id, action: 'none', reason: 'cancelled' };
  if (isClosed(ticket)) return { id, action: 'none', reason: 'closed' };

  // A ticket ticked in a new session, or after a reboot, should be workable
  // without a manual step. Its own failures never stop the step below.
  let dev: DevServerOutcome | null = null;
  if (ticket.worktree) {
    try {
      dev = await ensureDevServer({
        stateDir,
        repoRoot,
        ticket,
        timeoutMs: TICK_READY_TIMEOUT_MS,
      });
    } catch (err) {
      console.error(`warning: the app could not be started for ${id}: ${(err as Error).message}`);
    }
  }

  const result = await step({ stateDir, id, repoRoot, config, ticket });
  // A project with no app says nothing, so the result stays exactly as it was.
  return dev && dev !== 'no-dev-cmd' ? { ...result, dev } : result;
}

// Starts this ticket's app again by hand, and says what happened. This is what
// the advice printed by a failed start points at.
export async function vimaRestart({
  stateDir,
  id,
  repoRoot,
}: {
  stateDir: string;
  id: string;
  repoRoot: string;
}): Promise<DevServerOutcome> {
  const ticket = readTicket(stateDir, id);
  // Waited on, not just signalled: the new app would otherwise race the old
  // one for the same ports.
  const stopped = await stopDevServerAndWait({ stateDir, id });

  // The old one sat through SIGKILL and still holds these ports. Starting a
  // second copy now would leave two, and read the old socket as ready.
  const outcome = stopped ? await ensureDevServer({ stateDir, repoRoot, ticket }) : 'not-stopped';
  reportDevServer(outcome, { stateDir, id, ports: ticketPorts(ticket) });
  return outcome;
}

// Restarts every open ticket's app, one at a time. One bad ticket must never
// stop the others, so a failure is reported against its own id.
export async function vimaRestartAll({
  stateDir,
  repoRoot,
}: {
  stateDir: string;
  repoRoot: string;
}): Promise<{ id: string; outcome: DevServerOutcome | 'error'; reason?: string }[]> {
  const results: { id: string; outcome: DevServerOutcome | 'error'; reason?: string }[] = [];
  let tickets: { id: string }[] = [];
  try {
    tickets = listTickets(stateDir, {
      onUnreadable: (warning) => results.push({ id: 'unknown', outcome: 'error', reason: warning }),
    });
  } catch (err) {
    return [{ id: 'unknown', outcome: 'error', reason: (err as Error).message }];
  }

  for (const ticket of tickets) {
    try {
      results.push({
        id: ticket.id,
        outcome: await vimaRestart({ stateDir, id: ticket.id, repoRoot }),
      });
    } catch (err) {
      results.push({ id: ticket.id, outcome: 'error', reason: (err as Error).message });
    }
  }
  return results;
}

// The step itself. It takes the ticket vima already read, so the two do not
// read the same file twice.
async function step({
  stateDir,
  id,
  repoRoot,
  config,
  ticket: alreadyRead,
}: {
  stateDir: string;
  id: string;
  repoRoot: string;
  config: VimaConfig;
  ticket: Ticket;
}): Promise<VimaResult> {
  let ticket = alreadyRead;

  // A coder that stopped on purpose looks the same as one that finished.
  // The "stuck" mark is what tells them apart, and it always wins here.
  if (hasAporia(ticket)) {
    return notifyOnce({
      stateDir,
      id,
      config,
      ticket,
      action: 'none',
      reason: `needs you — ${ticket.aporia.reason}`,
    });
  }

  // The time limit turns a hung coder into "timed out" instead of "stuck"
  // forever, so we can kill it and report it.
  const coderStatus = backgroundStatus({
    stateDir,
    id,
    role: ROLES.CODER,
    maxRuntimeMs: config.ergonTimeoutMs,
  });
  if (coderStatus.state === 'timed-out') {
    // A kill that did not land must not be reported as one. The run is still
    // out there spending money, and "killed" would stop anyone looking.
    // byUser:false — the outcome recorded just below is `timed-out`, and that
    // is the reason worth keeping.
    const killed = killBackground({ stateDir, id, role: ROLES.CODER, byUser: false });
    const pid = killed ? null : backgroundPid({ stateDir, id, role: ROLES.CODER });
    // Saved here. The next round sees it and starts a new coder,
    // just like any other bad run.
    recordStage(stateDir, id, STAGES.ERGON, RUN_OUTCOMES.TIMED_OUT);
    return notifyOnce({
      stateDir,
      id,
      config,
      ticket,
      action: 'none',
      reason: killed
        ? 'coder run timed out — killed, needs you'
        : `coder run timed out and COULD NOT BE KILLED — it may still be running${
            pid == null ? '' : ` (pid ${pid})`
          }; stop it yourself, then look at this ticket`,
    });
  }
  if (RUNNING_STATES.has(coderStatus.state)) {
    return { id, action: 'none', reason: `coder ${coderStatus.state}` };
  }

  // The coder has stopped, one way or another. Its own tool calls may not have: nothing waits for
  // them once the coder's own exit code is written, so a survivor from a Bash call the coder made is
  // an orphan by every definition glafka has. Self-gating — costs nothing on a ticket already swept.
  reapOrphans({ stateDir, id, role: ROLES.CODER });

  // Before anything else is decided, pick up a `STUCK:`
  // line it left in its own output — the shell-free way of recording an impasse, for a coder that
  // could not reach `glafka aporia` at all. Without this the autonomous loop
  // sends a blocked ticket to a reviewer that will find an empty diff.
  if (recordStuckFromLog({ stateDir, id, ticket, status: coderStatus })) {
    ticket = readTicket(stateDir, id);
    return notifyOnce({
      stateDir,
      id,
      config,
      ticket,
      action: 'none',
      reason: `needs you — ${ticket.aporia?.reason}`,
    });
  }

  // A run that failed, or died without saying how it ended. We save that
  // once, or a half-finished branch would go to review and come back clean.
  if (
    coderStatus.state === 'failed' ||
    coderStatus.state === 'crashed' ||
    coderStatus.state === 'cancelled'
  ) {
    if (!hasRecordedOutcome({ stateDir, id })) {
      recordStage(
        stateDir,
        id,
        STAGES.ERGON,
        coderStatus.state === 'cancelled' ? RUN_OUTCOMES.CANCELLED : RUN_OUTCOMES.CRASHED,
      );
      markOutcomeRecorded({ stateDir, id, observability: config.observability.enabled });
      // The log just changed, so the copy we read at the top is out of date.
      // The check below reads exactly that.
      ticket = readTicket(stateDir, id);
    }
  }

  // A coder that FINISHED needs its outcome recorded here too, not only on the failure paths. This
  // is the autonomous path's only observation point, and leaving the marker unset is what let a
  // later `ergon --status` append a second `ergon` entry after the review and void a clean round.
  if (coderStatus.state === 'finished' && !hasRecordedOutcome({ stateDir, id })) {
    markOutcomeRecorded({ stateDir, id, observability: config.observability.enabled });
  }

  // Do not start a second reviewer while one is still running. Every role the round recorded, not
  // the literal "reviewer": naming one meant vima reported "needs you" mid-round, latched
  // `notified`, and then never sent the real "ready". A timed-out one is handled
  // further down.
  const busy = liveReviewerRoles({ stateDir, id, ticket }).find((role) =>
    ['running', 'stalled'].includes(
      backgroundStatus({ stateDir, id, role, maxRuntimeMs: config.ergonTimeoutMs }).state,
    ),
  );
  if (busy) {
    // The role IS "reviewer" when there is only one, so naming it again read
    // as "reviewer reviewer still running" on every tick of the common case.
    return {
      id,
      action: 'none',
      reason: busy === 'reviewer' ? 'reviewer still running' : `reviewer ${busy} still running`,
    };
  }

  // The QA tester is checking the acceptance criteria. Wait for it,
  // or stop it once it runs past the time limit.
  const verifierState = backgroundStatus({
    stateDir,
    id,
    role: ROLES.VERIFIER,
    maxRuntimeMs: config.ergonTimeoutMs,
  }).state;
  if (verifierState === 'timed-out') {
    // The kill is this whole tick, like the coder's: going on would read the dying run as live.
    const killed = killBackground({ stateDir, id, role: ROLES.VERIFIER, byUser: false });
    if (killed) {
      return {
        id,
        action: 'none',
        reason: 'verifier run timed out — stopped; the next tick closes its round',
      };
    }
    const pid = backgroundPid({ stateDir, id, role: ROLES.VERIFIER });
    return notifyOnce({
      stateDir,
      id,
      config,
      ticket,
      action: 'none',
      reason: `verifier run timed out and COULD NOT BE KILLED — it may still be running${
        pid == null ? '' : ` (pid ${pid})`
      }; stop it yourself, then look at this ticket`,
    });
  }
  if (verifierState === 'running' || verifierState === 'stalled') {
    return { id, action: 'none', reason: 'verifier still running' };
  }
  settleVerifierRun({ stateDir, id, observability: config.observability.enabled });

  // No coder has been started yet.
  if (coderStatus.state === 'not-started') {
    if (!ticket.planPath) return { id, action: 'none', reason: 'no plan yet' };
    return spawnCoder({ stateDir, id, repoRoot, config, ticket, why: 'plan approved' });
  }

  // The coder ran and stopped, and is not stuck. Has it been reviewed?
  // A commit by hand after the review. A person starts that paid round, never vima.
  if (hasUnreviewedCommit(ticket)) {
    return notifyOnce({
      stateDir,
      id,
      config,
      ticket,
      action: 'none',
      reason: `${UNREVIEWED_COMMIT} — review it: glafka ergon ${id} --review — needs you`,
    });
  }
  if (!isReviewedSinceLastChange(ticket)) {
    if (reviewRoundCount(ticket) >= config.maxReviewRounds) {
      return notifyOnce({
        stateDir,
        id,
        config,
        ticket,
        action: 'none',
        reason: `max review rounds (${config.maxReviewRounds}) reached — needs you`,
      });
    }
    return reviewOrVerify({ stateDir, id, repoRoot, config, ticket });
  }

  // It has been reviewed since the last change, so read the verdict.
  const { verdict } = ergonReviewStatus({
    stateDir,
    id,
    maxRuntimeMs: config.ergonTimeoutMs,
    observability: config.observability.enabled,
  });

  if (verdict.verdict === 'blocking') {
    if (reviewRoundCount(ticket) >= config.maxReviewRounds) {
      return notifyOnce({
        stateDir,
        id,
        config,
        ticket,
        action: 'none',
        reason: `blocking, and max review rounds (${config.maxReviewRounds}) reached — needs you`,
      });
    }
    return spawnCoder({
      stateDir,
      id,
      repoRoot,
      config,
      ticket,
      why: 'blocking findings from review',
    });
  }

  // Only a RECORDED clean is ready. A clean read out of the reviewer's own text says the same word
  // through a channel that proves nothing about who wrote it, and `vima` runs unattended — so this
  // is the one place where treating the two alike would walk a guess forward with nobody watching.
  if (verdict.verdict === 'clean' && verdict.source === VERDICT_SOURCE.KRISIS) {
    return afterCleanReview({ stateDir, id, repoRoot, config });
  }
  if (verdict.verdict === 'clean') {
    return notifyOnce({
      stateDir,
      id,
      config,
      ticket,
      action: 'none',
      reason: "clean, but only parsed from the reviewer's text — never recorded, so it needs you",
    });
  }

  // Unreadable, or the run failed. We never guess "clean" here.
  return notifyOnce({
    stateDir,
    id,
    config,
    ticket,
    action: 'none',
    reason: `verdict ${verdict.source} — needs you`,
  });
}

// A clean review is ready only once the acceptance criteria passed on the same code.
async function afterCleanReview({
  stateDir,
  id,
  repoRoot,
  config,
}: {
  stateDir: string;
  id: string;
  repoRoot: string;
  config: VimaConfig;
}): Promise<VimaResult> {
  const gate = verifyGate({ stateDir, id, maxRuntimeMs: config.ergonTimeoutMs });
  // Read after the gate: it may have just closed an ended round.
  const ticket = readTicket(stateDir, id);
  if (gate.kind === 'skip' || gate.kind === 'passed') {
    return notifyOnce({
      stateDir,
      id,
      config,
      ticket,
      action: 'ready',
      reason: 'clean — ready for you',
    });
  }
  // An open manual round: a person is recording the results.
  if (gate.kind === 'running') {
    return notifyOnce({
      stateDir,
      id,
      config,
      ticket,
      action: 'none',
      reason: `the QA round is still open — no result yet for ${gate.missing.join(', ')} — needs you`,
    });
  }
  // A QA result was already acted on since this review. A new round, or a fail on code that
  // changed since it closed, is a person's call: they may be fixing it right now.
  if (lastReviewQaBlocked(ticket) && !unusedOnSameCode(ticket)) {
    const gap = verificationGap(ticket) ?? 'a new QA round is due';
    return notifyOnce({
      stateDir,
      id,
      config,
      ticket,
      action: 'none',
      reason: `acceptance criteria: ${gap} — needs you`,
    });
  }
  // Already told: nothing has changed that a new try could use.
  if (waitsForVerifierAgent({ stateDir, ticket, config })) {
    return { id, action: 'none', reason: waitingReason(id) };
  }
  return reviewOrVerify({ stateDir, id, repoRoot, config, ticket });
}

// A closed round nobody acted on yet, on the same code that is here now.
function unusedOnSameCode(ticket: Ticket): boolean {
  const round = ticket.verification;
  if (!round || !ticket.worktree || round.consumed) return false;
  if (round.outcome === null || round.outcome === VERIFY_OUTCOME.PASSED) return false;
  return codeChanges(roundCode(round), codeFor(round, ticket.worktree)).length === 0;
}

// Runs `ergon --review` and starts whatever it asks for: a reviewer, or, after a clean review,
// the QA tester. A failure it reports is routed to a coder or to a person.
async function reviewOrVerify({
  stateDir,
  id,
  repoRoot,
  config,
  ticket,
}: {
  stateDir: string;
  id: string;
  repoRoot: string;
  config: VimaConfig;
  ticket: Ticket;
}): Promise<VimaResult> {
  let prepared;
  try {
    prepared = await ergonReview({
      stateDir,
      id,
      repoRoot,
      baseRef: config.baseRef ?? undefined,
      checksCmd: config.checksCmd,
      e2eCmd: config.e2eCmd,
      checksTimeoutMs: config.checksTimeoutMs,
      e2eTimeoutMs: config.e2eTimeoutMs,
      reviewDoc: config.reviewDoc,
      personaContent: config.personaContent ?? null,
    });
  } catch (err) {
    // It finished, committed nothing, and did not say why.
    // Trying again would just repeat that, so a person must look.
    if (err instanceof NothingToReviewError) {
      return notifyOnce({
        stateDir,
        id,
        config,
        ticket,
        action: 'none',
        reason: 'coder finished but committed nothing, and did not record why — needs you',
      });
    }
    // Failing checks that were ALREADY failing on the base commit. A coder cannot fix what it did not
    // break, so this must never reach spawnCoder — that is the loop that used to spend three paid runs on a red script nobody configured.
    if (err instanceof PreExistingChecksError) {
      return notifyOnce({
        stateDir,
        id,
        config,
        ticket,
        action: 'none',
        reason: `${err.message} — needs you`,
      });
    }
    // Checks failed, a criterion failed, or the last run died. More code really could fix it,
    // so one more coder is the right answer.
    if (err instanceof CoderFixableError) {
      // The last round sends no coder, whatever failed. The next tick stops at the
      // limit, so nobody would ever review that coder's work.
      if (reviewRoundCount(readTicket(stateDir, id)) >= config.maxReviewRounds) {
        return notifyOnce({
          stateDir,
          id,
          config,
          ticket,
          action: 'none',
          reason: `${err.message} — and max review rounds (${config.maxReviewRounds}) reached — needs you`,
        });
      }
      return spawnCoder({
        stateDir,
        id,
        repoRoot,
        config,
        ticket,
        // Reads as a cause, not a verdict. "review could not proceed" beside the action word `spawned-coder`
        // looked like the step had failed, when in fact a coder had just been started to fix exactly this.
        why: `sent back to the coder: ${err.message}`,
      });
    }
    // Everything else is a setup problem, like a missing worktree.
    // No coder can fix that, and trying costs real money.
    return notifyOnce({
      stateDir,
      id,
      config,
      ticket,
      action: 'none',
      reason: `review could not proceed: ${(err as Error).message} — needs you`,
    });
  }

  // A clean review left the acceptance criteria: the QA tester checks them on the same code.
  if (prepared.verify) {
    const verifierCmd = resolveAgentCmd({ config, role: ROLES.VERIFIER });
    if (!verifierCmd) {
      const told = notifyOnce({
        stateDir,
        id,
        config,
        ticket,
        action: 'none',
        reason: noVerifierReason(id),
      });
      // Marked with or without a notifyCmd: the wait above reads it, and must not rerun the checks.
      markNotified(stateDir, id);
      return told;
    }
    const stopped = wakeServicesOrStop({
      stateDir,
      id,
      repoRoot,
      config,
      ticket: prepared.ticket,
      agent: 'QA tester',
    });
    if (stopped) return stopped;
    // Said once, on the tick that pays for the tester. Read first, so it cannot fail after it.
    const strict = strictLevelWarning(repoRoot);
    const { pid } = dispatchVerifier({
      stateDir,
      ticket: prepared.ticket,
      verify: prepared.verify,
      agentCmd: verifierCmd,
      policy: resolvePolicy({ repoRoot }).policy,
    });
    return { id, action: 'spawned-verifier', pid, ...(strict ? { reason: strict } : {}) };
  }

  const reviewerCmd = resolveAgentCmd({ config, role: ROLES.REVIEWER });
  if (!reviewerCmd) {
    return {
      id,
      action: 'none',
      reason: 'checks green, but no reviewer agent configured — review manually',
    };
  }
  const { policy } = resolvePolicy({ repoRoot });

  // A large diff earns more than one reviewer. They read the same committed diff and need no worktree,
  // branch or port of their own, so they run side by side. Recorded BEFORE the spawns — see startReviewers.
  setReviewerRoles(
    stateDir,
    id,
    prepared.reviewers.map((r) => r.role),
  );

  const pids = prepared.reviewers.map(
    (reviewer) =>
      dispatchReviewer({
        stateDir,
        ticket: prepared.ticket,
        // A separate process — the only place the review token may travel.
        prompt: reviewer.reviewerPrompt,
        agentCmd: reviewerCmd,
        policy,
        role: reviewer.role,
      }).pid,
  );
  return { id, action: 'spawned-reviewer', pid: pids[0]!, reviewers: prepared.reviewers.length };
}

// One step per open ticket, one ticket at a time. Safe beats fast here.
// One bad ticket must never stop all the others from moving.
export async function vimaAll({
  stateDir,
  repoRoot,
  config,
}: {
  stateDir: string;
  repoRoot: string;
  config: VimaConfig;
}): Promise<VimaResult[]> {
  const results: VimaResult[] = [];

  // We build the list here, inside its own try, so one broken ticket file
  // can not kill the whole run. A skipped file is reported as an error.
  let tickets: { id: string }[] = [];
  try {
    tickets = listTickets(stateDir, {
      onUnreadable: (warning) => results.push({ id: 'unknown', action: 'error', reason: warning }),
    });
  } catch (err) {
    return [{ id: 'unknown', action: 'error', reason: (err as Error).message }];
  }

  for (const ticket of tickets) {
    try {
      results.push(await vima({ stateDir, id: ticket.id, repoRoot, config }));
    } catch (err) {
      // "error", not "none". "none" means we chose to do nothing, which is
      // fine. This means we could not decide at all.
      results.push({ id: ticket.id, action: 'error', reason: (err as Error).message });
    }
  }
  return results;
}
