import fs from 'node:fs';
import { updateTicket } from './store.js';
import { headTree, pathsChangedSince } from '../../util/git.js';
import { isTidyDoc } from '../../memory/docsStore.js';
import type { Ticket } from '../../types/ticket.js';

// --------------------------------------------------------------------------- The code a reviewer read

// Null when a review round starts, so an old round's tree never speaks for the new one.
export function setReviewedTree(stateDir: string, id: string, tree: string | null): void {
  updateTicket(stateDir, id, () => ({ reviewedTree: tree }));
}

// epistle's own rebase or docs commit moved HEAD just after the gate held on `from`.
// The same rule as refreshVerifiedCode: only a tree that still records `from` moves.
export function refreshReviewedTree(
  stateDir: string,
  id: string,
  { from, tree }: { from: string; tree: string },
): void {
  updateTicket(stateDir, id, (ticket) =>
    ticket.reviewedTree === from ? { reviewedTree: tree } : null,
  );
}

// True when HEAD is no longer the code the reviewer read. A commit by hand adds no stage
// entry, so only the tree can see it. No saved tree, or no worktree, is not a change.
export function reviewedCodeChanged(ticket: Ticket): boolean {
  const { reviewedTree, worktree } = ticket;
  if (!reviewedTree || !worktree || !fs.existsSync(worktree)) return false;
  if (headTree(worktree) === reviewedTree) return false;
  // Docs written after the review are not code. A tree git no longer has is a change.
  try {
    return pathsChangedSince(worktree, reviewedTree).some((file) => !isTidyDoc(file));
  } catch {
    return true;
  }
}
