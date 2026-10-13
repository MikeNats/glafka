import type { Ticket } from '../../../src/types/ticket.js';
import { AUDIT_STAGES } from '../../../src/audit/record.js';
import { ROLES } from '../../../src/types/ticket.js';
import type { Config } from '../../../src/types/config.js';
import type { CommandContext } from '../types/cli.js';
import { ergon, ergonBackground } from '../../../src/commands/ergon/ergon.js';
import { resolveAgentCmd, noAgentCmd } from '../../../src/config.js';
import { resolvePolicy } from '../../guardrails/index.js';
import { deliverPrompt } from './deliverPrompt.js';
import { reportGuardrails } from './guardrailsReport.js';

// Used by "genesis" and "plan". Once a ticket has a plan,
// both hand off to the coder from here.
export async function continueToErgon({
  ticket,
  repoRoot,
  stateDir,
  useBackground,
  config = {},
  checksCmd = null,
  e2eCmd = null,
  personaContent = null,
}: Pick<CommandContext, 'repoRoot' | 'stateDir' | 'personaContent'> & {
  ticket: Ticket;
  useBackground: boolean;
  config?: Partial<Pick<Config, 'agents' | 'observability' | 'baseRef'>>;
  checksCmd?: string | null;
  e2eCmd?: string | null;
}): Promise<void> {
  if (!ticket.planPath) return;

  if (useBackground) {
    // Same resolver every other spawn uses (see bin/commands/ergon.ts).
    const agentCmd = resolveAgentCmd({ config, role: ROLES.CODER });
    if (!agentCmd) throw new Error(noAgentCmd('--background'));
    const { policy } = resolvePolicy({ repoRoot });
    const { pid, guardrails } = await ergonBackground({
      stateDir,
      id: ticket.id,
      repoRoot,
      agentCmd,
      baseRef: config.baseRef ?? undefined,
      policy,
      checksCmd,
      e2eCmd,
      personaContent,
    });
    console.log(`${ticket.id}  ergon started in background (pid ${pid})`);
    reportGuardrails(policy, guardrails, ticket.guardrails?.widened);
    console.log(`check progress: glafka ergon ${ticket.id} --status`);
  } else {
    console.error(`--- ${ticket.id}: plan found, continuing to ergon ---`);
    const { prompt } = await ergon({
      stateDir,
      id: ticket.id,
      repoRoot,
      baseRef: config.baseRef ?? undefined,
      checksCmd,
      e2eCmd,
      personaContent,
    });
    const { policy } = resolvePolicy({ repoRoot });
    await deliverPrompt(prompt, {
      cwd: ticket.worktree,
      policy,
      stateDir,
      agentCmd: resolveAgentCmd({ config, role: ROLES.CODER }),
      // Not `cwd` — that is the worktree. The session reading the handover runs here.
      repoRoot,
      ticketId: ticket.id,
      stage: AUDIT_STAGES.ERGON,
      role: ROLES.CODER,
      observability: config.observability?.enabled,
    });
  }
}
