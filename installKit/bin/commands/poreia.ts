import {
  poreia,
  poreiaAll,
  renderPoreia,
  renderPoreiaAll,
} from '../../../src/commands/poreia/poreia.js';
import { assertKnownFlags } from '../cli/args.js';
import type { Config } from '../../../src/types/config.js';

// Shows ticket status. No agent calls, just reads saved state. Every flag this command reads.
// Anything else is a typo, and a typo used to be silently ignored — sometimes into a different action entirely.
const POREIA_FLAGS = ['--all'];
const POREIA_USAGE =
  'usage: glafka poreia <ticket-id>\n       glafka poreia --all   one line per open ticket';

export function runPoreia({
  args,
  stateDir,
  repoRoot,
  config,
}: {
  args: string[];
  stateDir: string;
  repoRoot: string;
  config: Pick<Config, 'baseRef'>;
}): void {
  assertKnownFlags(args, POREIA_FLAGS, POREIA_USAGE);
  // Without the base branch the commit list counts commits merged in FROM it
  // as this ticket's own steps.
  const baseRef = config.baseRef;
  // One line per open ticket.
  function printAllTickets() {
    console.log(renderPoreiaAll(poreiaAll({ stateDir, repoRoot, baseRef })));
  }

  function printOneTicket() {
    const id = args.find((arg) => !arg.startsWith('--'));
    if (!id) {
      throw new Error(
        'usage: glafka poreia <ticket-id>\n' +
          '       glafka poreia --all   one line per open ticket',
      );
    }
    console.log(renderPoreia(poreia({ stateDir, id, repoRoot, baseRef })));
  }

  if (args.includes('--all')) return printAllTickets();
  return printOneTicket();
}
