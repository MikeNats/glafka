import { pendingCandidates, CANDIDATE_SOURCE } from '../ticket/ticketStore.js';
import type { Ticket, EthosCandidate } from '../types/ticket.js';

// A person decides on proposed rules. It refuses instead of asking,
// because an agent runs this, not a human at a keyboard.

// The numbers start at 1, matching the list we show.
export function parseKeepArg(keep: string, pendingCount: number): number[] {
  if (keep === 'all') return Array.from({ length: pendingCount }, (_, i) => i + 1);
  if (keep === 'none') return [];

  // Refuse bad input. A typo could keep the wrong rule.
  const parts = String(keep)
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (parts.length === 0) {
    throw new Error(`--keep needs "all", "none", or 1-based indices like "1,3" — got "${keep}"`);
  }

  const picked = new Set<number>();
  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      throw new Error(
        `--keep index "${part}" isn't a number — use "all", "none", or indices like "1,3"`,
      );
    }
    const n = Number(part);
    if (n < 1 || n > pendingCount) {
      throw new Error(
        `--keep index ${n} is out of range — there are ${pendingCount} candidate(s) awaiting a decision`,
      );
    }
    picked.add(n);
  }
  return [...picked].sort((a, b) => a - b);
}

// The smallest shape the listing needs.
// It never reads the status, so that field is not required.
export interface PendingRuleListing {
  target: string;
  source: string;
  text: string;
}

// Shows who proposed each rule. Your own are easy to confirm,
// while a guess from an agent needs a real look.
export function formatPendingListing(pending: PendingRuleListing[]): string {
  return pending
    .map((c, i) => {
      // Falls back to "agent", so every source prints something.
      const who = c.source === CANDIDATE_SOURCE.YOU ? 'you said' : (c.source ?? 'agent');
      return `  ${i + 1}. [${c.target}] (${who}) ${c.text}`;
    })
    .join('\n');
}

// We print the command name in the error, so it matches what you ran.
export function resolveKeep({
  ticket,
  keep,
  command,
}: {
  ticket: Pick<Ticket, 'id' | 'ethosCandidates'>;
  keep: string | null | undefined;
  command: string;
}): { pending: EthosCandidate[]; keepIndexes: number[] } {
  const pending = pendingCandidates(ticket);
  if (pending.length === 0) return { pending, keepIndexes: [] };

  if (keep === null || keep === undefined) {
    throw new Error(
      `ticket ${ticket.id} has ${pending.length} ethos candidate(s) awaiting a decision — ` +
        `these become permanent project rules that every future agent reads, so ` +
        `${command} can't decide for you:\n${formatPendingListing(pending)}\n\n` +
        `Read them, then run one of:\n` +
        `  glafka ${command} ${ticket.id} --keep all       keep all of them\n` +
        `  glafka ${command} ${ticket.id} --keep 1,3       keep only those\n` +
        `  glafka ${command} ${ticket.id} --keep none      discard all of them`,
    );
  }

  return { pending, keepIndexes: parseKeepArg(keep, pending.length) };
}
