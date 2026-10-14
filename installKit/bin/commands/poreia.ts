import {
  poreia,
  poreiaAll,
  renderPoreia,
  renderPoreiaAll,
} from '../../../src/commands/poreia/poreia.js';
import { poreiaJson, poreiaAllJson } from '../../../src/commands/poreia/json.js';
import { assertKnownFlags } from '../cli/args.js';
import { printJson } from '../cli/json.js';
import type { Config } from '../../../src/types/config.js';

// Shows ticket status. No agent calls, just reads saved state. Every flag this command reads.
// Anything else is a typo, and a typo used to be silently ignored — sometimes into a different action entirely.
const POREIA_FLAGS = ['--all', '--json'];
const POREIA_USAGE =
  'usage: glafka poreia <ticket-id> [--json]\n' +
  '       glafka poreia --all [--json]   one line per open ticket\n' +
  '       --json                         print one JSON document instead, for other tools';

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
  // Same tickets either way. Only the printing differs.
  const json = args.includes('--json');

  // One line per open ticket.
  function printAllTickets() {
    if (json) return printJson({ tickets: poreiaAllJson({ stateDir, repoRoot, baseRef }) });
    console.log(renderPoreiaAll(poreiaAll({ stateDir, repoRoot, baseRef })));
  }

  function printOneTicket() {
    const id = args.find((arg) => !arg.startsWith('--'));
    if (!id) throw new Error(POREIA_USAGE);
    // A list of one, so a reader handles one shape for both forms.
    if (json) return printJson({ tickets: [poreiaJson({ stateDir, id, repoRoot, baseRef })] });
    console.log(renderPoreia(poreia({ stateDir, id, repoRoot, baseRef })));
  }

  if (args.includes('--all')) return printAllTickets();
  return printOneTicket();
}
