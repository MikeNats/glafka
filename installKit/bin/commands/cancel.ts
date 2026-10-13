import { cancel } from '../../../src/commands/cancel/cancel.js';
import { describeTicket } from '../../../src/ticket/ticketStore.js';
import { assertKnownFlags } from '../cli/args.js';

// Abandons a ticket before it is pushed. Every flag this command reads. Anything else is a typo, and
// a typo used to be silently ignored — sometimes into a different action entirely.
const CANCEL_FLAGS = ['--force'];
const CANCEL_USAGE = 'usage: glafka cancel <ticket-id> [--force]';

export async function runCancel({
  args,
  repoRoot,
  stateDir,
}: {
  args: string[];
  repoRoot: string;
  stateDir: string;
}): Promise<void> {
  assertKnownFlags(args, CANCEL_FLAGS, CANCEL_USAGE);
  const id = args.find((arg) => !arg.startsWith('--'));
  if (!id) {
    throw new Error(
      'usage: glafka cancel <ticket-id> [--force]\n' +
        '       glafka poreia --all   lists the tickets you have',
    );
  }
  const ticket = await cancel({ repoRoot, stateDir, id, force: args.includes('--force') });
  console.log(`${ticket.id} -> ${describeTicket(ticket)}`);
}
