import fs from 'node:fs';
import { runFiles } from '../../ticket/paths.js';
import { reviewerRoles, reviewFindings } from '../../ticket/ticketStore.js';
import type { Ticket } from '../../types/ticket.js';

// True when a reviewer started, or a verdict came in, after this QA round opened. False means
// every reviewer verdict on disk is from before it. A round saved without `openedAt` says true.
export function reviewerStartedSinceRound(stateDir: string, ticket: Ticket): boolean {
  const openedAt = ticket.verification?.openedAt;
  if (!openedAt) return true;
  const since = Date.parse(openedAt);
  const started = reviewerRoles(ticket).some((role) => {
    const { startedAtPath } = runFiles(stateDir, ticket.id, role);
    return fs.existsSync(startedAtPath) && Number(fs.readFileSync(startedAtPath, 'utf8')) >= since;
  });
  return started || reviewFindings(ticket).some((f) => Date.parse(f.at) >= since);
}
