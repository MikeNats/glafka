import fs from 'node:fs';
import { ticketCommits, latestCommitMessage, hasUncommittedChanges } from '../../util/git.js';
import type { Ticket } from '../../types/ticket.js';

export interface Progress {
  commits: number;
  latestCommit: string | null;
  uncommittedChanges: boolean;
}

// How far the last run got, read from git history.
// Null when there is no starting point or no worktree.
export function readProgress(
  ticket: Pick<Ticket, 'planCommit' | 'worktree'>,
  // The base branch, so commits merged in FROM it are not counted as this
  // ticket's own work. Null keeps the old, wider range.
  baseRef: string | null = null,
): Progress | null {
  if (!ticket.planCommit || !ticket.worktree || !fs.existsSync(ticket.worktree)) {
    return null;
  }
  const commits = ticketCommits(ticket.worktree, ticket.planCommit, baseRef);
  return {
    commits,
    latestCommit: commits > 0 ? latestCommitMessage(ticket.worktree) : null,
    uncommittedChanges: hasUncommittedChanges(ticket.worktree),
  };
}
