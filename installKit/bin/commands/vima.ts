import { vima, vimaAll, vimaRestart, vimaRestartAll } from '../../../src/commands/vima/vima.js';
import type { VimaConfig, VimaResult } from '../../../src/commands/vima/utils.js';
import { assertKnownFlags, positionalId } from '../cli/args.js';
import { printJson } from '../cli/json.js';
import { resolveTicketId } from '../../../src/ticket/resolve.js';

// Moves a ticket one step forward. Safe to run on a timer. It never pushes and never closes a
// ticket. Every flag this command reads. Anything else is a typo, and a typo used to be silently
// ignored — sometimes into a different action entirely.
const VIMA_FLAGS = ['--all', '--restart', '--json'];
const VIMA_USAGE =
  'usage: glafka vima <ticket-id> [--json]\n' +
  '       glafka vima --all [--json]          advance every open ticket by one step\n' +
  "       glafka vima <ticket-id> --restart   start this ticket's app again\n" +
  "       glafka vima --all --restart         start every open ticket's app again\n" +
  '       --json                              print the results as one JSON document';

export async function runVima({
  args,
  stateDir,
  repoRoot,
  config,
}: {
  args: string[];
  stateDir: string;
  repoRoot: string;
  config: VimaConfig;
}): Promise<void> {
  assertKnownFlags(args, VIMA_FLAGS, VIMA_USAGE);
  const json = args.includes('--json');
  // A restart reports on stderr as it goes, so there is no one result to print.
  if (json && args.includes('--restart')) {
    throw new Error(`--json is not supported with --restart\n\n${VIMA_USAGE}`);
  }

  function printResults(results: VimaResult[]): void {
    if (json) return printJson({ results });
    for (const result of results) {
      console.log(`${result.id}  ${result.action}${result.reason ? `  — ${result.reason}` : ''}`);
    }
  }

  async function advanceAllTickets(): Promise<void> {
    const results = await vimaAll({ stateDir, repoRoot, config });
    printResults(results);
    // Exit code 1 tells the timer that something needs your attention.
    const failed = results.filter((result) => result.action === 'error');
    if (failed.length > 0) {
      console.error(
        `${failed.length} of ${results.length} ticket(s) errored this tick — the rest advanced normally`,
      );
      process.exitCode = 1;
    }
  }

  async function advanceOneTicket(): Promise<void> {
    // No id typed: work it out. After a clear nobody remembers the id, and
    // that friction is what kept people in the old session.
    const id = args.find((arg) => !arg.startsWith('--')) ?? resolveTicketId({ stateDir, repoRoot });
    printResults([await vima({ stateDir, id, repoRoot, config })]);
  }

  // What the advice printed by a failed start tells you to run. It never
  // advances the ticket — the app is the only thing it touches.
  async function restartApp(): Promise<void> {
    // Same resolver as advancing. Restarting an app from inside its own
    // worktree is the exact case this exists for.
    const id = positionalId(args) ?? resolveTicketId({ stateDir, repoRoot });
    // Every other outcome has already been said out loud by reportDevServer.
    if ((await vimaRestart({ stateDir, id, repoRoot })) === 'no-dev-cmd') {
      console.log(`${id}  nothing to restart — this project has no devCmd to run`);
    }
  }

  // One line per ticket on stdout. reportDevServer has already put the detail
  // of each one on stderr.
  async function restartEveryApp(): Promise<void> {
    const results = await vimaRestartAll({ stateDir, repoRoot });
    for (const result of results) {
      console.log(`${result.id}  ${result.outcome}${result.reason ? `  — ${result.reason}` : ''}`);
    }
    const failed = results.filter((result) => result.outcome === 'error');
    if (failed.length > 0) {
      console.error(`${failed.length} of ${results.length} ticket(s) could not be restarted`);
      process.exitCode = 1;
    }
  }

  if (args.includes('--restart')) {
    return args.includes('--all') ? restartEveryApp() : restartApp();
  }
  if (args.includes('--all')) return advanceAllTickets();
  return advanceOneTicket();
}
