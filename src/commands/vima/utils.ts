import { execFileSync } from 'node:child_process';
import { ROLES } from '../../types/ticket.js';
import { resolveAgentCmd, EXAMPLE_AGENT_CMD } from '../../config.js';
import { resolvePolicy } from '../../../installKit/guardrails/index.js';
import { wasNotified, markNotified } from '../../ticket/ticketStore.js';
import { ergonBackground } from '../ergon/ergon.js';
import { RunNotStartedError } from '../../ticket/background.js';
import { wakeTicketServices } from '../../ticket/wakeServices.js';
import type { DevServerOutcome } from '../../ticket/resources.js';
import type { Config } from '../../types/config.js';
import type { Ticket } from '../../types/ticket.js';
import { shellPath } from '../../util/shell.js';

// Only the settings the step loop really reads.
// Setup settings belong to resources.ts, not here.
export type VimaConfig = Pick<
  Config,
  | 'ergonTimeoutMs'
  | 'maxReviewRounds'
  | 'baseRef'
  | 'checksCmd'
  | 'e2eCmd'
  | 'checksTimeoutMs'
  | 'e2eTimeoutMs'
  | 'notifyCmd'
  | 'agents'
  | 'observability'
  // vima dispatches reviewers too, so it needs whatever the reviewer prompt reads.
  | 'reviewDoc'
>;

// The result of one step for one ticket. It is one flat shape, because
// callers read its fields directly. Some fields are set only sometimes.
export interface VimaResult {
  id: string;
  action: 'none' | 'ready' | 'spawned-coder' | 'spawned-verifier' | 'spawned-reviewer' | 'error';
  reason?: string;
  pid?: number;
  // How many reviewers the round started. Absent when none were.
  reviewers?: number;
  // What this tick had to do about the ticket's app.
  // Absent when the project has no app to run.
  dev?: DevServerOutcome;
}

export async function spawnCoder({
  stateDir,
  id,
  repoRoot,
  config,
  ticket,
  why,
}: {
  stateDir: string;
  id: string;
  repoRoot: string;
  config: VimaConfig;
  ticket: Ticket;
  why: string;
}): Promise<VimaResult> {
  const agentCmd = resolveAgentCmd({ config, role: ROLES.CODER });
  if (!agentCmd) {
    return {
      id,
      action: 'none',
      reason:
        `${why} — no coder agent configured to (re)spawn. Set ` +
        `"agents": { "coder": "${EXAMPLE_AGENT_CMD}" } in .glafka.json, or GLAFKA_AGENT_CMD in the ` +
        `environment. It must be able to edit files and run commands without asking — see \`glafka --help\``,
    };
  }
  const stopped = wakeServicesOrStop({ stateDir, id, repoRoot, config, ticket, agent: 'coder' });
  if (stopped) return stopped;
  const { policy } = resolvePolicy({ repoRoot });
  try {
    const { pid } = await ergonBackground({
      stateDir,
      id,
      repoRoot,
      agentCmd,
      policy,
      checksCmd: config.checksCmd,
      e2eCmd: config.e2eCmd,
      // The tick this runs inside already ensured the app, with its own much
      // shorter wait. Ensuring again costs the tick a second one.
      ensureApp: false,
    });
    return { id, action: 'spawned-coder', pid, reason: why };
  } catch (err) {
    // Anything else is a real error and must stay visible as one.
    if (!(err instanceof RunNotStartedError)) throw err;
    // The start itself was refused, for example because a cage would not go
    // up. Stop the ticket and tell someone, instead of pretending it ran.
    return notifyOnce({
      stateDir,
      id,
      config,
      ticket,
      action: 'none',
      reason: `${why} — but the coder could not be started: ${(err as Error).message}`,
    });
  }
}

// Runs wakeCmd before vima starts an agent. Null means go on; a result means stop,
// since an agent handed a dead database only chases a bug that is not there.
export function wakeServicesOrStop({
  stateDir,
  id,
  repoRoot,
  config,
  ticket,
  agent,
}: {
  stateDir: string;
  id: string;
  repoRoot: string;
  config: Pick<Config, 'notifyCmd'>;
  ticket: Ticket;
  agent: 'coder' | 'QA tester';
}): VimaResult | null {
  try {
    wakeTicketServices({ repoRoot, ticket });
    return null;
  } catch (err) {
    return notifyOnce({
      stateDir,
      id,
      config,
      ticket,
      action: 'none',
      reason: `wakeCmd failed, so no ${agent} was started: ${(err as Error).message} — needs you`,
    });
  }
}

// Runs the notify command once per state,
// and only for "ready" or "needs you".
export function notifyOnce({
  stateDir,
  id,
  config,
  ticket,
  action,
  reason,
}: {
  stateDir: string;
  id: string;
  config: Pick<Config, 'notifyCmd'>;
  ticket: Ticket;
  action: 'none' | 'ready';
  reason: string;
}): VimaResult {
  if (!wasNotified(ticket) && config.notifyCmd) {
    runNotify(config.notifyCmd, { id, reason });
    markNotified(stateDir, id);
  }
  return { id, action, reason };
}

// Every command a user can set needs a time limit. Without one, a notify
// command that hangs would stop the whole run and every ticket behind it.
export const NOTIFY_TIMEOUT_MS = 10_000;

export function runNotify(
  notifyCmd: string,
  { id, reason, timeoutMs = NOTIFY_TIMEOUT_MS }: { id: string; reason: string; timeoutMs?: number },
): void {
  try {
    execFileSync(shellPath(), ['-c', notifyCmd], {
      env: { ...process.env, GLAFKA_TICKET_ID: id, GLAFKA_MSG: `${id}: ${reason}` },
      stdio: 'ignore',
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    });
  } catch (err) {
    // A broken notify command must not fail the run. We still say when we
    // killed it, so a hang does not look like a message that was sent.
    const killed = (err as { signal?: string }).signal === 'SIGKILL';
    if (killed) {
      console.error(`notifyCmd for ${id} did not finish within ${timeoutMs}ms — killed`);
    }
  }
}
