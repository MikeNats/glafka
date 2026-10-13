import fs from 'node:fs';
import path from 'node:path';
import { ticketsDir, closedTicketsDir, ticketFiles, auditPath } from '../ticket/paths.js';
import { readStageLog } from '../ticket/ticketStore/store.js';
import { readRunRecords } from './record.js';

// The permanent copy, written into git at close. Kept apart from record.ts,
// which is the live append-and-read side: this file runs once per ticket, and
// only ever reads what that one wrote.

// The ticket's history, wherever the ticket now lives. Same open-then-closed
// order recordPath uses, so the two halves of the audit never come from
// different copies of the same ticket.
function stagesPath(stateDir: string, ticketId: string): string {
  const active = ticketFiles(ticketsDir(stateDir), ticketId);
  if (fs.existsSync(active.stagesFile)) return active.stagesFile;

  const closed = ticketFiles(closedTicketsDir(stateDir), ticketId);
  return fs.existsSync(closed.stagesFile) ? closed.stagesFile : active.stagesFile;
}

// Writes the ticket's rows into git, where they outlive the state directory.
// Call it at close only: the numbers are complete and no run is still
// appending, which is why lysis does it right after recordUnobservedRuns.
// Returns the file written, or null when the ticket recorded nothing at all.
//
// BOTH logs, merged by time, the same join `readAudit` does. Copying the run
// record alone left the git audit — the only copy anyone reads later — with no
// create, no spec and no plan on it, so the whole half of a ticket that
// starts no process was missing from the one file people actually read.
export function publishAudit({
  repoRoot,
  stateDir,
  ticketId,
}: {
  repoRoot: string;
  stateDir: string;
  ticketId: string;
}): string | null {
  const runs = readRunRecords(stateDir, ticketId);
  const stages = readStageLog(stagesPath(stateDir, ticketId));
  if (runs.length === 0 && stages.length === 0) return null;

  // `kind` is what tells the two apart on the way back in: both carry a
  // `stage` field, and they mean different things.
  const rows = [
    ...runs.map((run) => ({ ...run })),
    ...stages.map((stage) => ({ ...stage, kind: 'stage' })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  const to = auditPath(repoRoot, ticketId);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  // Written last, in one call. A throw before this leaves the rows where they
  // were, so the close can be retried once whatever stopped it is fixed.
  fs.writeFileSync(to, rows.map((row) => `${JSON.stringify(row)}\n`).join(''));
  return to;
}
