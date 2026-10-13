import { runIsolationHook } from './resources/isolationHooks.js';
import { readIsolationProfile } from '../memory/docsStore.js';
import { readTicketEnv } from './resources/ticketEnv.js';
import type { Ticket } from '../types/ticket.js';

// `setupCmd` gives a ticket its own database, and then nothing watches it. One died — Exited (255)
// — with nothing to notice or bring it back, and the ticket only looked broken later, from failing
// tests. A coder handed a dead database does not see a dead database: it sees its own work failing,
// and spends the hour chasing a bug that is not there.
//
// So `wakeCmd` runs before every coder run. It is the command a person would type by hand —
// `docker start my-app-$GLAFKA_TICKET_ID` — and it must be safe to run when nothing is wrong, since
// glafka has no way to ask whether these services are up. Starting something already started is a
// no-op for every runner that has the verb; asking each of them how to check is not.
export function wakeTicketServices({
  repoRoot,
  ticket,
  timeoutMs,
  run = runIsolationHook,
}: {
  repoRoot: string;
  ticket: Ticket;
  timeoutMs?: number;
  run?: typeof runIsolationHook;
}): { ran: boolean } {
  const profile = readIsolationProfile(repoRoot);
  const cmd = profile?.wakeCmd;
  if (!cmd || !ticket.worktree) return { ran: false };

  run(cmd, {
    cwd: ticket.worktree,
    // The same environment setupCmd had, so the command can name the very container it made.
    env: {
      ...readTicketEnv(ticket.worktree),
      GLAFKA_TICKET_ID: ticket.id,
      GLAFKA_REPO_ROOT: repoRoot,
      GLAFKA_WORKTREE: ticket.worktree,
    },
    ...(timeoutMs ? { timeout: timeoutMs } : {}),
    label: 'wakeCmd',
  });
  return { ran: true };
}
