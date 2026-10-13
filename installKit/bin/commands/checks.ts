import { ticketChecks } from '../../../src/commands/checks/checks.js';
import { CHECK_VERDICT, explainNoChecks } from '../../../src/checks.js';
import { readTicket } from '../../../src/ticket/ticketStore.js';
import type { Config } from '../../../src/types/config.js';
import { positionalId, assertKnownFlags } from '../cli/args.js';

// Every flag this command reads. Anything else is a typo, and a typo used to be
// silently ignored — sometimes into a different action entirely.
const CHECKS_FLAGS: string[] = [];
const CHECKS_USAGE = 'usage: glafka checks <ticket-id>';

export async function runChecksCommand({
  args,
  stateDir,
  repoRoot,
  config,
}: {
  args: string[];
  stateDir: string;
  repoRoot: string;
  config: Pick<Config, 'baseRef' | 'checksCmd' | 'e2eCmd' | 'checksTimeoutMs' | 'e2eTimeoutMs'>;
}): Promise<void> {
  assertKnownFlags(args, CHECKS_FLAGS, CHECKS_USAGE);
  const id = positionalId(args);
  if (!id) {
    throw new Error(`${CHECKS_USAGE}\n       glafka poreia --all   lists the tickets you have`);
  }

  const { ticket, checks, verdict, saved } = await ticketChecks({
    stateDir,
    id,
    repoRoot,
    baseRef: config.baseRef ?? 'main',
    checksCmd: config.checksCmd,
    e2eCmd: config.e2eCmd,
    checksTimeoutMs: config.checksTimeoutMs,
    e2eTimeoutMs: config.e2eTimeoutMs,
  });

  for (const check of checks) {
    // A check that printed too much is UNVERIFIED, never FAILED — same three
    // states `ergon --status` prints, so the two never disagree on wording.
    const label = check.passed ? 'PASSED' : check.unknown ? 'UNVERIFIED' : 'FAILED';
    console.log(`  ${check.name}: ${label}`);
    if (!check.passed) console.log(check.output.replace(/^/gm, '    '));
  }

  if (verdict === CHECK_VERDICT.UNKNOWN && checks.length === 0) {
    // The whole reason someone runs this command is that nothing ran last time.
    // Sending them away without the fix would repeat the dead end it exists to end.
    console.log(explainNoChecks(ticket.worktree));
    process.exitCode = 1;
    return;
  }

  if (verdict === CHECK_VERDICT.FAILED) {
    console.log(`${id}  checks FAILED — fix them, then run this again`);
    process.exitCode = 1;
    return;
  }

  if (!saved) {
    // Saved results are keyed to a commit. With uncommitted edits in the worktree there is no
    // commit to key them to, so nothing was written and epistle's gate has not moved — say so,
    // rather than let a green run read as a green gate.
    console.log(
      `${id}  checks ${verdict} — but the worktree has uncommitted changes, so the result was ` +
        `NOT saved against a commit and the push gate is unchanged.\n` +
        `  commit the work, then run this again: glafka checks ${id}`,
    );
    return;
  }

  const pushed = readTicket(stateDir, id);
  console.log(
    verdict === CHECK_VERDICT.PASSED
      ? `${id}  checks PASSED and are recorded against this commit — it can be pushed`
      : `${id}  checks ${verdict} — recorded, but nothing was proven`,
  );
  if (verdict === CHECK_VERDICT.PASSED && pushed.branch) {
    console.log(`  push it: glafka epistle ${id}`);
  }
}
