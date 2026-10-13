import { attachPlan } from '../../../src/commands/genesis/genesis.js';
import { continueToErgon } from '../agent/continueToErgon.js';
import { warnGuardrailsNotReady } from '../agent/guardrailsReport.js';
import type { Config } from '../../../src/types/config.js';
import { assertKnownFlags } from '../cli/args.js';
import { ticketReport } from '../cli/ticketReport.js';

// On its own, it prints the ticket details and stops. With `--background`, it goes straight on to
// start the coder. Every flag this command reads. Anything else is a typo, and a typo used to be
// silently ignored — sometimes into a different action entirely.
const PLAN_FLAGS = ['--background'];
const PLAN_USAGE = 'usage: glafka plan <ticket-id> <plan-file> [--background]';

export async function runPlan({
  args,
  stateDir,
  repoRoot,
  config,
  personaContent,
}: {
  args: string[];
  stateDir: string;
  repoRoot: string;
  config: Pick<
    Config,
    | 'baseRef'
    | 'portRange'
    | 'bootstrapTimeoutMs'
    | 'isolationHookTimeoutMs'
    | 'checksCmd'
    | 'checksTimeoutMs'
    | 'e2eCmd'
    // `--background` spawns the coder, so it needs to see where the coder is
    // configured — the same resolver `vima` uses.
    | 'agents'
    | 'observability'
  >;
  personaContent: string | null;
}): Promise<void> {
  assertKnownFlags(args, PLAN_FLAGS, PLAN_USAGE);
  // Before provisioning, not after: this is the last point where nothing has
  // been built yet and the answer is still cheap to act on.
  warnGuardrailsNotReady({ repoRoot, baseRef: config.baseRef ?? 'main' });
  const backgroundIdx = args.indexOf('--background');
  const useBackground = backgroundIdx !== -1;
  if (useBackground) args.splice(backgroundIdx, 1);
  const [id, planPath] = args;

  const ticket = await attachPlan({
    stateDir,
    repoRoot,
    id,
    planPath,
    baseRef: config.baseRef ?? undefined,
    portRange: config.portRange,
    bootstrapTimeoutMs: config.bootstrapTimeoutMs,
    isolationHookTimeoutMs: config.isolationHookTimeoutMs,
    // Turns the checks baseline on only where glafka would be guessing.
    checksCmd: config.checksCmd,
    checksTimeoutMs: config.checksTimeoutMs,
    observability: config.observability.enabled,
  });
  console.log(ticketReport(ticket));
  if (useBackground) {
    await continueToErgon({
      ticket,
      repoRoot,
      stateDir,
      useBackground: true,
      config,
      checksCmd: config.checksCmd,
      e2eCmd: config.e2eCmd,
      personaContent,
    });
  }
}
