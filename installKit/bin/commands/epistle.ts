import { epistle } from '../../../src/commands/epistle/epistle.js';
import { AUDIT_STAGES } from '../../../src/audit/record.js';
import { ROLES } from '../../../src/types/ticket.js';
import { deliverPrompt } from '../agent/deliverPrompt.js';
import { resolvePolicy } from '../../guardrails/index.js';
import type { Config } from '../../../src/types/config.js';
import type { Ticket } from '../../../src/types/ticket.js';
import { resolveAgentCmd } from '../../../src/config.js';
import { assertKnownFlags } from '../cli/args.js';
import {
  readAuditProposals,
  writeAuditWatermark,
} from '../../../src/memory/ethosAudit/ethosAudit.js';
import { runAuditPass } from '../../../src/memory/ethosAudit/runPass.js';

// Every flag this command reads. Anything else is a typo, and a typo used to be silently ignored —
// sometimes into a different action entirely.
// `--unverified` was folded into `--unreviewed`: one switch for "I am overriding a gate", so a
// person can not wave past the checks gate while still believing the review gate held. It stays
// listed here so the old spelling gives a real answer instead of the generic unknown-flag error.
const EPISTLE_FLAGS = ['--unreviewed', '--no-tidy'];
const EPISTLE_USAGE = 'usage: glafka epistle <ticket-id> [--unreviewed] [--no-tidy]';
const RETIRED_FLAGS: Readonly<Record<string, string>> = Object.freeze({
  '--unverified': '--unverified is gone — --unreviewed now opens the checks gate too',
});

export async function runEpistle({
  args,
  stateDir,
  repoRoot,
  config,
}: {
  args: string[];
  stateDir: string;
  repoRoot: string;
  config: Pick<Config, 'baseRef' | 'agents' | 'observability' | 'checksCmd' | 'e2eCmd'>;
}): Promise<void> {
  for (const [flag, why] of Object.entries(RETIRED_FLAGS)) {
    if (args.includes(flag)) throw new Error(`${why}\n${EPISTLE_USAGE}`);
  }
  assertKnownFlags(args, EPISTLE_FLAGS, EPISTLE_USAGE);
  const id = args.find((arg) => !arg.startsWith('--'));
  if (!id) {
    throw new Error(
      `${EPISTLE_USAGE}\n` + '       glafka poreia --all   lists the tickets you have',
    );
  }
  const skipTidy = args.includes('--no-tidy');
  // Said BEFORE the push, not after. With no reporter configured the two doc steps print their
  // prompt and return false, and nobody looks at that false — so the run ended with "docs already
  // matched this branch — nothing to commit", which is true only because nothing ever read them.
  // Every default install produced exactly this state, so the line most people saw was the wrong
  // one. Not a refusal: printing the prompt for the session to act on is a real, documented path.
  const noReporter = !skipTidy && resolveAgentCmd({ config, role: ROLES.REPORTER }) === null;
  if (noReporter) {
    console.log(
      `  ⚠ no "agents.reporter" in .glafka.json — the doc sync and the architecture update will\n` +
        `    PRINT their prompt instead of running. Nothing will be committed by them.\n` +
        `    set one:  glafka install   (probes an agent and writes it), or add it by hand`,
    );
  }
  const { ticket, tidyCommitted, hostExec, bypassed, prUpdated } = await epistle({
    stateDir,
    id,
    repoRoot,
    base: config.baseRef ?? undefined,
    // Opens every gate that can be opened: no review since the last code change,
    // no verdict, an unrecorded one, and checks that never ran.
    unreviewed: args.includes('--unreviewed'),
    // Not to run anything — only to rebuild the key `glafka checks` saved under,
    // so checks run since the review still count.
    checksCmd: config.checksCmd,
    e2eCmd: config.e2eCmd,
    // The tidy-up. Runs BEFORE the push, in the worktree, and its edits are
    // committed onto the branch so they travel with the PR.
    runTidy: skipTidy ? undefined : (prompts) => tidyUp({ ...prompts, repoRoot, stateDir, config }),
  });

  if (hostExec) console.log(`\n${hostExec}\n`);
  if (skipTidy) {
    console.log('  tidy-up skipped (--no-tidy) — the plan and the map may not match this branch');
  } else if (tidyCommitted.length > 0) {
    console.log(`  docs updated and committed: ${tidyCommitted.join(', ')}`);
  } else if (noReporter) {
    // "already matched" is a claim about the docs. Nothing read them, so we do not get to make it.
    console.log('  docs NOT checked — no reporter agent ran (see the warning above)');
  } else {
    console.log('  docs already matched this branch — nothing to commit');
  }
  // "opened" and "updated" are different facts, and a branch only ever gets one PR — so every push
  // after the first updates the one already there. Saying "opened" each time made a routine second
  // push look like it had made a second pull request.
  console.log(`\n${ticket.id}  pushed  ·  PR ${prUpdated ? 'updated' : 'opened'}: ${ticket.prUrl}`);
  // Last line, because it is the one thing about this push worth remembering. It was written onto
  // the ticket and nowhere a person looks, so an overridden push and a fully verified one printed
  // exactly the same thing.
  if (bypassed)
    console.log(`  ⚠ gates walked past: ${bypassed}  (recorded on the ticket and the PR)`);
}

// The two doc agents and the ethos audit, run in the ticket's worktree so their edits land on the
// branch. Split out only because it has three exits of its own.
async function tidyUp({
  ticket,
  docSyncPrompt,
  odysseUpdatePrompt,
  auditDue,
  repoRoot,
  stateDir,
  config,
}: {
  ticket: Ticket;
  docSyncPrompt: string | null;
  odysseUpdatePrompt: string;
  auditDue: { due: boolean; count: number; grown: number };
  repoRoot: string;
  stateDir: string;
  config: Pick<Config, 'agents' | 'observability'>;
}): Promise<void> {
  const { policy } = resolvePolicy({ repoRoot });
  // Both prompts name paths inside the worktree, so the agent has to run there
  // or it will write the main checkout's copy again.
  const cwd = ticket.worktree ?? repoRoot;
  const agentCmd = resolveAgentCmd({ config, role: ROLES.REPORTER });

  if (docSyncPrompt) {
    console.error(`--- ${ticket.id}: checking the plan doc against what was actually built ---`);
    await deliverPrompt(docSyncPrompt, {
      cwd,
      policy,
      stateDir,
      agentCmd,
      ticketId: ticket.id,
      stage: AUDIT_STAGES.EPISTLE,
      role: ROLES.REPORTER,
      observability: config.observability.enabled,
    });
  }

  console.error(`--- ${ticket.id}: updating architecture docs for what this ticket touched ---`);
  await deliverPrompt(odysseUpdatePrompt, {
    cwd,
    policy,
    stateDir,
    agentCmd,
    ticketId: ticket.id,
    stage: AUDIT_STAGES.EPISTLE,
    role: ROLES.REPORTER,
    observability: config.observability.enabled,
  });

  // The ethos audit writes proposals to state, never to a doc, so nothing it does needs committing.
  // Proposals nobody has decided on yet: running the pass again would spend a
  // call to overwrite them, so this comes BEFORE the due check.
  const pending = readAuditProposals(repoRoot);
  if (pending.length > 0) {
    console.error(
      `\n--- ethos ---\n${pending.length} compaction proposal(s) still waiting:\n` +
        `  glafka odysse --compact --keep all | none`,
    );
    return;
  }
  if (!auditDue.due) return;

  console.error(
    `\n--- ethos ---\n` +
      `${auditDue.count} rule(s) in force, ${auditDue.grown} since the last compaction.`,
  );
  const { ran, proposals, skip, ruleCount } = runAuditPass({
    repoRoot,
    config,
    stateDir,
    observability: config.observability.enabled,
  });
  // Recorded whatever the outcome was. Asking again on every push is how this
  // would spend a call, or hang on a broken agent, forever.
  writeAuditWatermark(repoRoot, ruleCount);
  if (!ran) {
    // A 30-line prompt in the middle of a push is noise. One line instead.
    console.error(`  run it by hand: glafka odysse --compact   (${skip})`);
  } else if (proposals.length === 0) {
    console.error('nothing to compact.');
  } else {
    console.error(
      `${proposals.length} proposal(s) waiting — nothing changed yet:\n` +
        `  glafka odysse --compact --keep all\n` +
        `  glafka odysse --compact --keep none`,
    );
  }
}
