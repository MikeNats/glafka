import { heureka } from '../../../src/commands/heureka/heureka.js';
import { AUDIT_STAGES } from '../../../src/audit/record.js';
import { ROLES } from '../../../src/types/ticket.js';
import { deliverPrompt } from '../agent/deliverPrompt.js';
import { resolvePolicy } from '../../guardrails/index.js';
import type { Config } from '../../../src/types/config.js';
import { resolveAgentCmd } from '../../../src/config.js';
import { helpRequested, exitWithUsage, flagValue } from '../cli/args.js';

const HEUREKA_USAGE = [
  'usage: glafka heureka "<rough idea>" [--name "<words>"]',
  '',
  'Explores an idea in real code — no spec, no plan, no approval gate.',
  'It acquires a worktree straight away, unlike create.',
  '',
  '--name is for an idea with no letters a-z in it to slug.',
].join('\n');

export async function runHeureka({
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
  // Free text, same as `create` — `--help` asks for help only when it is all
  // there is, not when it is part of what the idea is about.
  if (helpRequested(args, { alone: true })) exitWithUsage(HEUREKA_USAGE);

  const name = flagValue(args, '--name', 'some words to name the ticket by');
  // The flag and its value are ours, not part of what the ticket is about.
  const idx = args.indexOf('--name');
  const rest = name === null ? args : [...args.slice(0, idx), ...args.slice(idx + 2)];

  const { ticket, prompt } = await heureka({
    repoRoot,
    stateDir,
    idea: rest.join(' '),
    name,
    baseRef: config.baseRef ?? undefined,
    portRange: config.portRange,
    bootstrapTimeoutMs: config.bootstrapTimeoutMs,
    isolationHookTimeoutMs: config.isolationHookTimeoutMs,
    // Turns the checks baseline on only where glafka would be guessing.
    checksCmd: config.checksCmd,
    checksTimeoutMs: config.checksTimeoutMs,
    personaContent,
  });
  console.error(`--- ${ticket.id}  ${ticket.worktree} ---`);
  const { policy } = resolvePolicy({ repoRoot });
  await deliverPrompt(prompt, {
    cwd: ticket.worktree,
    policy,
    stateDir,
    agentCmd: resolveAgentCmd({ config, role: ROLES.CODER }),
    // Not `cwd` — that is the worktree. The session reading the handover runs here.
    repoRoot,
    ticketId: ticket.id,
    stage: AUDIT_STAGES.HEUREKA,
    role: ROLES.CODER,
    observability: config.observability.enabled,
  });
}
