import { updateTicket } from './store.js';
import { aporiaReason, VERIFY_OUTCOME } from './verification.js';
import type { Ticket, Verification, VerifyOutcome } from '../../types/ticket.js';

// --------------------------------------------------------------------------- Closing and using up a QA round

// The round the caller read, by its token hash. A newer round is never touched.
const isRound = (round: Verification | null, tokenHash: string | null): round is Verification =>
  round != null && round.token === tokenHash;

type Verdict = { outcome: VerifyOutcome; detail: string };
// `judge` reads the ticket under the lock, so a result saved a moment ago is judged too.
type CloseWith = Verdict | { judge: (ticket: Ticket) => Verdict };

// True when THIS call closed the round. `code` is what the code was at the close.
// A `cannot` also stops the ticket for a person, unless an aporia already stops it.
export function closeVerifyRound(
  stateDir: string,
  id: string,
  options: CloseWith & {
    tokenHash: string | null;
    code?: { tree: string; dirty: string[] } | null;
  },
): boolean {
  const { tokenHash, code = null } = options;
  let closed = false;
  updateTicket(stateDir, id, (ticket) => {
    const round = ticket.verification;
    if (!isRound(round, tokenHash) || round.outcome !== null) return null;
    closed = true;
    const { outcome, detail } = 'judge' in options ? options.judge(ticket) : options;
    const at =
      outcome === VERIFY_OUTCOME.CANNOT && !ticket.aporia ? new Date().toISOString() : null;
    const closedCode = code ?? { tree: round.tree, dirty: round.dirty };
    return {
      verification: { ...round, outcome, detail, aporiaAt: at, closedCode },
      ...(at ? { aporia: { reason: aporiaReason(detail), at } } : {}),
    };
  });
  return closed;
}

// epistle's own rebase or docs commit moved HEAD just after the gate held on `from`.
// A passed round that still records `from` moves to the new code; nothing else changes.
export function refreshVerifiedCode(
  stateDir: string,
  id: string,
  { from, tree, dirty }: { from: string; tree: string; dirty: string[] },
): void {
  updateTicket(stateDir, id, (ticket) => {
    const round = ticket.verification;
    if (round?.outcome !== VERIFY_OUTCOME.PASSED || round.tree !== from) return null;
    // New files glafka's own checks made stay out, as they did at the close.
    const made = new Set(round.checkMade ?? []);
    const code = { tree, dirty: dirty.filter((line) => !made.has(line)) };
    return { verification: { ...round, ...code, closedCode: code } };
  });
}

// The outcome was acted on once. The next `ergon --review` starts a new round.
export function consumeVerifyRound(stateDir: string, id: string, tokenHash: string | null): void {
  updateTicket(stateDir, id, (ticket) =>
    isRound(ticket.verification, tokenHash)
      ? { verification: { ...ticket.verification, consumed: true } }
      : null,
  );
}
