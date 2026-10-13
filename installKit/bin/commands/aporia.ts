import { recordAporia } from '../../../src/ticket/ticketStore.js';
import { ROLES } from '../../../src/types/ticket.js';
import { markExternalRunFinished } from '../../../src/ticket/background.js';
import { positionalId, assertKnownFlags } from '../cli/args.js';

// Marks a ticket as stopped on purpose, waiting on a person. Different from just finished. Every flag
// this command reads. Anything else is a typo, and a typo used to be silently ignored — sometimes into a different action entirely.
const APORIA_FLAGS = ['--reason'];
const APORIA_USAGE = 'usage: glafka aporia <ticket-id> --reason "<what\'s blocking you>"';

export function runAporia({ args, stateDir }: { args: string[]; stateDir: string }): void {
  assertKnownFlags(args, APORIA_FLAGS, APORIA_USAGE);
  const id = positionalId(args, { spread: ['--reason'] });
  const reasonIdx = args.indexOf('--reason');
  // Stop at the next flag, or at the id.
  let reason: string | null = null;
  if (reasonIdx !== -1) {
    const words = [];
    for (const word of args.slice(reasonIdx + 1)) {
      if (word.startsWith('--') || word === id) break;
      words.push(word);
    }
    reason = words.join(' ') || null;
  }

  if (!id || !reason) {
    throw new Error(`usage: glafka aporia <id> --reason "<what's blocking you>"`);
  }

  recordAporia(stateDir, id, reason);
  // The coder is telling us it stopped. For a run dispatched into someone's own session that is the
  // only signal glafka ever gets, so it is what ends the run — otherwise a blocked ticket also
  // reads as one still being worked on, forever. Exit code 1: it stopped without
  // finishing. A no-op for a run glafka spawned, whose real exit code is the truth.
  const ended = markExternalRunFinished({ stateDir, id, role: ROLES.CODER, exitCode: 1 });
  console.log(`${id}  aporia recorded: ${reason}`);
  if (ended) console.log(`its coder run is marked stopped, so later commands do not wait on it`);
  console.log(`this ticket now needs a human decision before it continues`);
}
