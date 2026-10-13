import { lysis, findOrphans, purgeOrphan } from '../../../src/commands/lysis/lysis.js';
import { describeTicket } from '../../../src/ticket/ticketStore.js';
import { keepArg, killArg, positionalId, assertKnownFlags } from '../cli/args.js';
import { askYesNo, hasTty } from '../cli/tty.js';
import { parseKeepArg } from '../../../src/memory/ethosGate.js';
import type { Config } from '../../../src/types/config.js';

// Every flag this command reads. Anything else is a typo.
// `--kill` was missing, so the command the sweep tells you to run was rejected.
const LYSIS_FLAGS = ['--force', '--keep', '--pr-settled', '--sweep', '--kill'];
const LYSIS_USAGE =
  'usage: glafka lysis <ticket-id> [--force] [--pr-settled] [--keep all|none|1,3]\n       glafka lysis <ticket-id> --sweep   find and remove leftover state';

export async function runLysis({
  args,
  repoRoot,
  stateDir,
  config,
}: {
  args: string[];
  repoRoot: string;
  stateDir: string;
  config: Pick<Config, 'bootstrapTimeoutMs' | 'observability'>;
}): Promise<void> {
  assertKnownFlags(args, LYSIS_FLAGS, LYSIS_USAGE);
  // Also finds and offers to delete other leftover state.
  async function sweepOrphans(id: string): Promise<void> {
    const { orphans } = findOrphans({
      repoRoot,
      stateDir,
      bootstrapTimeoutMs: config.bootstrapTimeoutMs,
    });
    if (orphans.length === 0) {
      console.log('nothing else orphaned');
      return;
    }

    // With no terminal, just list them and do not guess.
    const kill = killArg(args);
    if (kill === null && !hasTty()) {
      console.error(`${orphans.length} orphan(s) found, and no terminal to ask on:`);
      orphans.forEach((orphan, i) =>
        console.error(`  ${i + 1}. ${orphan.label} — ${orphan.detail}`),
      );
      console.error(`\nShow this to a human. To act without a terminal:`);
      console.error(`  glafka lysis ${id} --sweep --kill all     delete all of them`);
      console.error(`  glafka lysis ${id} --sweep --kill 1,3     delete only those`);
      console.error(`  glafka lysis ${id} --sweep --kill none    delete nothing`);
      return;
    }

    const chosen = kill === null ? null : new Set(parseKeepArg(kill, orphans.length));

    let deletedCount = 0;
    // A loop, not forEach: purgeOrphan stops the orphan's app and has to be
    // awaited, and an async callback there would not be.
    for (const [i, orphan] of orphans.entries()) {
      const shouldDelete =
        chosen === null
          ? askYesNo(`delete ${orphan.label}?  (${orphan.detail})`)
          : chosen.has(i + 1);
      if (!shouldDelete) {
        console.log(`kept    ${orphan.label}`);
        continue;
      }
      await purgeOrphan({ repoRoot, stateDir, orphan });
      deletedCount += 1;
      console.log(`deleted ${orphan.label}`);
    }
    console.log(`${deletedCount}/${orphans.length} orphan(s) deleted`);
  }

  // `--keep` is only needed if something is still waiting on you.
  const id = positionalId(args, { single: ['--keep'] });
  if (!id) {
    throw new Error(
      'usage: glafka lysis <ticket-id> [--keep all|none|1,3] [--force] [--sweep]\n' +
        '       glafka poreia --all   lists the tickets you have',
    );
  }
  const keep = keepArg(args);

  const sweep = args.includes('--sweep');
  let releaseFailed: Error | null = null;

  try {
    const ticket = await lysis({
      repoRoot,
      stateDir,
      id,
      keep,
      // Only matters when GitHub can not be checked.
      prSettled: args.includes('--pr-settled'),
      // Throw away uncommitted work in the worktree, deliberately.
      force: args.includes('--force'),
      observability: config.observability.enabled,
    });
    console.log(`${ticket.id} -> ${describeTicket(ticket)}`);
    for (const candidate of ticket.promoted)
      console.log(`kept  [${candidate.target}] ${candidate.text}`);
  } catch (err) {
    // An interrupted setup leaves a worktree the TICKET does not know about, so
    // lysis threw "no worktree/branch" and took the sweep down with it.
    if (!sweep) throw err;
    releaseFailed = err as Error;
    console.error(`could not release ${id}: ${releaseFailed.message}`);
    console.error('sweeping for leftover state anyway, because --sweep was asked for.\n');
  }

  if (sweep) await sweepOrphans(id);
  // Rethrown after the sweep, never swallowed: the ticket is still open, and the
  // exit code has to say so even though the sweep may have cleaned up around it.
  if (releaseFailed) throw releaseFailed;
}
