import path from 'node:path';
import { listTickets } from './ticketStore.js';
import { currentBranch } from '../util/git.js';
import { worktreesRoot } from './paths.js';
import { TICKET_ID_RE } from './ids.js';

// The ticket id when the cwd is inside its worktree, from any depth.
// Null when the cwd is somewhere else, or the folder is not an id.
function idFromCwd(repoRoot: string, cwd: string): string | null {
  const root = path.resolve(worktreesRoot(repoRoot));
  const rel = path.relative(root, path.resolve(cwd));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const first = rel.split(path.sep)[0] ?? '';
  return TICKET_ID_RE.test(first) ? first : null;
}

// Which ticket the person means when they typed no id. Throws rather than
// asking, because vima is documented as safe to run on a timer.
export function resolveTicketId({
  stateDir,
  repoRoot,
  cwd = process.cwd(),
}: {
  stateDir: string;
  repoRoot: string;
  cwd?: string;
}): string {
  const open = listTickets(stateDir);

  const fromCwd = idFromCwd(repoRoot, cwd);
  if (fromCwd && open.some((ticket) => ticket.id === fromCwd)) return fromCwd;

  // The whole branch name, never a piece of it. Branch names are not always
  // "glafka/<id>", so cutting one up would match real branches.
  let branch: string | null = null;
  try {
    branch = currentBranch(repoRoot);
  } catch {
    branch = null;
  }
  if (branch) {
    const onBranch = open.filter((ticket) => ticket.branch === branch);
    if (onBranch.length === 1) return onBranch[0]!.id;
  }

  if (open.length === 1) return open[0]!.id;

  if (open.length === 0) {
    throw new Error('no open tickets — start one with: glafka create "<idea>"');
  }
  throw new Error(
    `which ticket? the current folder is not inside a worktree, and ` +
      `${branch ?? 'the current branch'} is not a ticket branch:\n` +
      open.map((ticket) => `  ${ticket.id}`).join('\n') +
      `\n\nname one: glafka vima <ticket-id>`,
  );
}
