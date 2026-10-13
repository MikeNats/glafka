import {
  genesis,
  buildSpecPrompt,
  buildPlanPrompt,
} from '../../../src/commands/genesis/genesis.js';
import { AUDIT_STAGES } from '../../../src/audit/record.js';
import { ROLES } from '../../../src/types/ticket.js';
import { loadPromptContext } from '../../../src/memory/context.js';
import { deliverPrompt } from '../agent/deliverPrompt.js';
import { continueToErgon } from '../agent/continueToErgon.js';
import { resolvePolicy } from '../../guardrails/index.js';
import type { Config } from '../../../src/types/config.js';
import { assertKnownFlags } from '../cli/args.js';
import { ticketReport } from '../cli/ticketReport.js';

// Prints a spec prompt for a ticket that already exists.
async function printSpecDraft({
  args,
  repoRoot,
  stateDir,
  personaContent,
  config,
}: {
  args: string[];
  repoRoot: string;
  stateDir: string;
  personaContent: string | null;
  config: Pick<Config, 'observability'>;
}): Promise<void> {
  const ticketId = args[1];
  if (!ticketId) {
    throw new Error(
      `usage: glafka genesis --draft <id> "<idea>" — run "glafka create <idea>" first to get an id`,
    );
  }
  const idea = args.slice(2).join(' ');
  const { policy } = resolvePolicy({ repoRoot });
  // The same context every other prompt gets. There is no worktree yet,
  // but none of these parts need one.
  await deliverPrompt(
    buildSpecPrompt(idea, {
      ...loadPromptContext({ repoRoot }),
      personaContent,
      ticketId,
      repoRoot,
    }),
    {
      cwd: repoRoot,
      policy,
      stateDir,
      ticketId,
      stage: AUDIT_STAGES.GENESIS,
      // No resolveAgentCmd call here to read a role from — this path drafts
      // text for a person to read, not code, so 'reporter' fits best.
      role: ROLES.REPORTER,
      observability: config.observability.enabled,
    },
  );
}

// Turns a spec into a plan prompt.
async function printPlanDraft({
  args,
  repoRoot,
  stateDir,
  config,
}: {
  args: string[];
  repoRoot: string;
  stateDir: string;
  config: Pick<Config, 'observability'>;
}): Promise<void> {
  const ticketId = args[1];
  if (!ticketId) {
    throw new Error(`usage: glafka genesis --plan-draft <id> "<approved spec>"`);
  }
  const specContent = args.slice(2).join(' ');
  const { policy } = resolvePolicy({ repoRoot });
  await deliverPrompt(
    buildPlanPrompt(specContent, { ...loadPromptContext({ repoRoot }), ticketId }),
    {
      cwd: repoRoot,
      policy,
      stateDir,
      ticketId,
      stage: AUDIT_STAGES.GENESIS,
      // Same reasoning as printSpecDraft: drafts text, resolves no agent role.
      role: ROLES.REPORTER,
      observability: config.observability.enabled,
    },
  );
}

// Opens a real ticket. With `--plan` it saves a plan and starts the coder.
// `--background` needs an agent command to be set.
async function openTicket({
  args,
  repoRoot,
  stateDir,
  config,
  personaContent,
}: {
  args: string[];
  repoRoot: string;
  stateDir: string;
  config: Config;
  personaContent: string | null;
}): Promise<void> {
  const backgroundIdx = args.indexOf('--background');
  const useBackground = backgroundIdx !== -1;
  if (useBackground) args.splice(backgroundIdx, 1);

  const planFlagIdx = args.indexOf('--plan');
  const content = planFlagIdx === -1 ? args.join(' ') : args.slice(0, planFlagIdx).join(' ');
  const planContent = planFlagIdx === -1 ? null : args.slice(planFlagIdx + 1).join(' ');

  const ticket = await genesis({
    repoRoot,
    stateDir,
    content,
    planContent,
    baseRef: config.baseRef ?? undefined,
    portRange: config.portRange,
    bootstrapTimeoutMs: config.bootstrapTimeoutMs,
    isolationHookTimeoutMs: config.isolationHookTimeoutMs,
    // Turns the checks baseline on only where glafka would be guessing.
    checksCmd: config.checksCmd,
    checksTimeoutMs: config.checksTimeoutMs,
  });
  console.log(ticketReport(ticket));
  await continueToErgon({
    ticket,
    repoRoot,
    stateDir,
    useBackground,
    config,
    checksCmd: config.checksCmd,
    e2eCmd: config.e2eCmd,
    personaContent,
  });
}

// Every flag this command reads. Anything else is a typo, and a typo used to be silently ignored —
// sometimes into a different action entirely.
const GENESIS_FLAGS = ['--background', '--draft', '--plan', '--plan-draft'];
const GENESIS_USAGE =
  'usage: glafka genesis "<idea>" [--draft|--plan <file>|--plan-draft] [--background]';

export async function runGenesis({
  args,
  repoRoot,
  stateDir,
  config,
  personaContent,
}: {
  args: string[];
  repoRoot: string;
  stateDir: string;
  config: Config;
  personaContent: string | null;
}): Promise<void> {
  assertKnownFlags(args, GENESIS_FLAGS, GENESIS_USAGE);
  if (args[0] === '--draft') {
    return printSpecDraft({ args, repoRoot, stateDir, personaContent, config });
  }
  if (args[0] === '--plan-draft') return printPlanDraft({ args, repoRoot, stateDir, config });
  return openTicket({ args, repoRoot, stateDir, config, personaContent });
}
