import { headTree, uncommittedPaths } from '../../util/git.js';
import type { Verification } from '../../types/ticket.js';

// What the code is right now: the tree plus uncommitted files. A rebase keeps the tree only
// when the base did not move, so epistle re-records it after its own rebase.
export interface CodeState {
  tree: string;
  dirty: string[];
}

export function codeState(worktree: string): CodeState {
  return { tree: headTree(worktree), dirty: uncommittedPaths(worktree) };
}

// The code as a round sees it: new files glafka's own checks made are left out.
export function codeFor(round: Pick<Verification, 'checkMade'>, worktree: string): CodeState {
  return withoutCheckMade(codeState(worktree), round.checkMade ?? []);
}

export function withoutCheckMade(code: CodeState, checkMade: string[]): CodeState {
  const made = new Set(checkMade);
  return { tree: code.tree, dirty: code.dirty.filter((line) => !made.has(line)) };
}

// The `??` lines the checks just made, plus the ones an earlier round's checks made that are
// still there. Only new untracked files: a check that edits a tracked file changed the code.
export function checkMadeLines(before: string[], after: string[], earlier: string[]): string[] {
  const had = new Set(before);
  const made = after.filter(
    (line) => line.startsWith('??') && (!had.has(line) || earlier.includes(line)),
  );
  return [...new Set(made)];
}

// The code a closed round is judged on: the code at its close. An open round, or one
// saved before closedCode existed, has only the code at its start.
export function roundCode(round: Pick<Verification, 'tree' | 'dirty' | 'closedCode'>): CodeState {
  return round.closedCode ?? { tree: round.tree, dirty: round.dirty };
}

// What differs between the round's code and now. Empty means the same code.
export function codeChanges(round: CodeState, now: CodeState): string[] {
  const changes: string[] = [];
  if (round.tree !== now.tree) changes.push('HEAD (a new commit)');
  const before = new Set(round.dirty);
  const after = new Set(now.dirty);
  for (const line of now.dirty) if (!before.has(line)) changes.push(line.trim());
  for (const line of round.dirty) if (!after.has(line)) changes.push(line.trim());
  return changes;
}
