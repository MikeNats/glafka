import type { Ticket } from '../../../src/types/ticket.js';

// What we print once a ticket has its worktree. One labelled fact per line,
// because the old single spaced-out line was something you had to parse.
export function ticketReport(ticket: Ticket): string {
  const lines = [`Ticket ${ticket.id}`];
  // No `devCmd` means no port was reserved. Skip the line rather than print null.
  if (ticket.port !== null) lines.push(`Port:     ${ticket.port}`);
  if (ticket.worktree !== null) lines.push(`Worktree: ${ticket.worktree}`);
  if (ticket.branch !== null) lines.push(`Branch:   ${ticket.branch}`);

  // Extra services from isolation.json, each on its own port.
  const extra = Object.entries(ticket.isolationPorts ?? {});
  for (const [name, port] of extra) lines.push(`Port:     ${port}  (${name})`);

  return lines.join('\n');
}
