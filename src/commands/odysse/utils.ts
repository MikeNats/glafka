import { readWorkspaceProposal, workspaceAtoms } from '../../memory/docsStore.js';

// What the scan found about making a worktree run, still waiting for a
// decision. It stays its own list, so the numbers do not get mixed up.
export function readWorkspaceProposalListing(repoRoot: string): string[] {
  return workspaceAtoms(readWorkspaceProposal(repoRoot)).map((atom) => atom.label);
}
