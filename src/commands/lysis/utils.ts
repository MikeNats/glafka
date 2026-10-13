import fs from 'node:fs';
import path from 'node:path';
import { loadCategories, targetsOf } from '../../memory/categories.js';
import type { Ticket } from '../../types/ticket.js';
import type { pullRequestState } from '../../util/git.js';

// If we can not reach GitHub, we refuse instead of guessing.
// `--pr-settled` only skips that check. A PR we can see is open still blocks.
export function prState({
  repoRoot,
  ticket,
  getPrState,
  prSettled,
}: {
  repoRoot: string;
  ticket: Pick<Ticket, 'id' | 'prUrl'>;
  getPrState: typeof pullRequestState;
  prSettled: boolean;
}): string | null {
  try {
    return getPrState({ cwd: repoRoot, prUrl: ticket.prUrl! });
  } catch (err) {
    if (prSettled) return null;
    throw new Error(
      `ticket ${ticket.id}: can't ask GitHub whether its PR is still open (${ticket.prUrl}) — ${(err as Error).message}\n` +
        `  closing force-deletes the worktree and branch, and from here a merged PR looks exactly like a live one\n` +
        `  once you have checked the PR yourself: glafka lysis ${ticket.id} --pr-settled   (recorded on the ticket)`,
    );
  }
}

// Finds rule files whose category was removed from the config.
// Read one before you delete it. Its rules may still be useful.
export function findOrphanEthosFiles(repoRoot: string): string[] {
  const ethosDir = path.join(repoRoot, 'docs/glafka/ethos');
  if (!fs.existsSync(ethosDir)) return [];

  const configured = new Set(targetsOf(loadCategories(repoRoot)));
  return fs
    .readdirSync(ethosDir)
    .filter((name) => name.startsWith('ETHOS_') && name.endsWith('.md'))
    .filter((name) => !configured.has(name.slice(0, -'.md'.length)));
}
