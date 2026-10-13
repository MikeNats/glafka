import fs from 'node:fs';
import { deleteBranch, removeWorktree } from '../../util/git.js';
import { readIsolationProfile } from '../../memory/docsStore.js';
import { assertIsTicketWorktree, ticketScratchPath } from '../paths.js';
import { stopDevServerAndWait } from '../devServer.js';
import { portEnv } from './ticketEnv.js';
import type { IsolationProfileLike } from './ticketEnv.js';
import { DEFAULT_ISOLATION_HOOK_TIMEOUT_MS, runIsolationHook } from './isolationHooks.js';

// A bad isolation.json must block setup, but on teardown it made every ticket unclosable: lysis and cancel both threw
// before the worktree was touched. So teardown degrades to "no profile", loudly — teardownCmd is skipped, not the close.
function readProfileForTeardown(repoRoot: string): IsolationProfileLike | null {
  try {
    return readIsolationProfile(repoRoot) as IsolationProfileLike | null;
  } catch (err) {
    console.error(
      `warning: the isolation profile could not be read, so teardownCmd is being skipped for this ` +
        `ticket — anything it would have stopped (containers, databases) is still running and needs ` +
        `stopping by hand. The worktree is still being removed; the branch is kept. ` +
        `Cause: ${(err as Error).message}`,
    );
    return null;
  }
}

// The smallest shape releaseResources needs. A real Ticket fits it,
// and so does the stand-in that acquireResources builds for cleanup.
export interface ReleaseableTicket {
  id: string;
  branch: string;
  worktree: string;
  isolationPorts?: Record<string, number> | null;
}

// The opposite of acquireResources, and what lysis runs to close a ticket.
// The app stops first, then teardownCmd, while the worktree still exists.
export async function releaseResources({
  repoRoot,
  ticket,
  stateDir = null,
  profile = undefined,
  isolationHookTimeoutMs = DEFAULT_ISOLATION_HOOK_TIMEOUT_MS,
  discardBranch = false,
}: {
  repoRoot: string;
  ticket: ReleaseableTicket;
  // Where the app's pid file lives. Without it there is no app to stop.
  stateDir?: string | null;
  profile?: IsolationProfileLike | null;
  isolationHookTimeoutMs?: number;
  discardBranch?: boolean;
}): Promise<void> {
  // Before teardownCmd: an app still holding a database connection can make
  // removing its container hang.
  if (stateDir) {
    try {
      await stopDevServerAndWait({ stateDir, id: ticket.id });
    } catch (err) {
      // A ticket that cannot be closed is worse than a process to kill by hand,
      // so a failed stop is said out loud and the close carries on.
      console.error(
        `warning: the app for ${ticket.id} could not be stopped, so it may still be running: ` +
          `${(err as Error).message}`,
      );
    }
  }

  const isolationProfile = profile === undefined ? readProfileForTeardown(repoRoot) : profile;

  // Same check as acquire: no services needed. A profile with no services
  // can still have made something, like a shared database.
  if (isolationProfile) {
    const env = portEnv(isolationProfile, ticket.isolationPorts);
    // Same shape as acquire's hookEnv, so teardown matches setup.
    const hookEnv = {
      ...env,
      GLAFKA_TICKET_ID: ticket.id,
      GLAFKA_REPO_ROOT: repoRoot,
      GLAFKA_WORKTREE: ticket.worktree,
    };
    // The worktree may be gone. Node can not start in a missing folder,
    // so fall back to the repo root.
    const worktreeGone = !fs.existsSync(ticket.worktree);
    for (const [label, cmd] of [
      ['teardownCmd', isolationProfile.teardownCmd],
      ['e2e.teardownCmd', isolationProfile.e2e?.teardownCmd],
    ] as const) {
      if (!cmd) continue;
      // A failing teardownCmd must not stop the cleanup below,
      // or the ticket could never close.
      try {
        runIsolationHook(cmd, {
          cwd: worktreeGone ? repoRoot : ticket.worktree,
          env: hookEnv,
          timeout: isolationHookTimeoutMs,
          label,
        });
      } catch (err) {
        console.error(`warning: ${label} failed for ${ticket.id}: ${(err as Error).message}`);
      }
    }
  }

  releaseGitResources({ repoRoot, ticket, discardBranch });
}

// The half of releaseResources that runs no hooks and awaits nothing, so a signal
// handler can finish it before the process goes.
export function releaseGitResources({
  repoRoot,
  ticket,
  discardBranch = false,
}: {
  repoRoot: string;
  ticket: ReleaseableTicket;
  discardBranch?: boolean;
}): void {
  // Already gone is fine. We want it to not exist, not to delete it.
  try {
    removeWorktree(repoRoot, ticket.worktree, { force: true });
  } catch (err) {
    const text = `${(err as { stderr?: string; message?: string }).stderr ?? ''}${(err as Error).message ?? ''}`;
    // These two errors mean "already gone". Anything else is real.
    if (!/not a working tree|no such file or directory/i.test(text)) throw err;
    // Checked right before we delete, so a wrong path is never erased.
    assertIsTicketWorktree(ticket.worktree);
    fs.rmSync(ticket.worktree, { recursive: true, force: true });
  }

  // Believe the directory, not the exit code. `git worktree remove --force` exiting 0 while leaving
  // files behind could not be reproduced (a plain `node_modules/`, and one with a nested repo in
  // it, were both removed cleanly) — but a real close reported `.worktrees/<id>/node_modules/` still
  // on disk afterwards, and "teardown left something behind" is the wrong way for this command to
  // end. So the claim is checked rather than trusted. Same guard as the fallback above: a path that
  // is not a ticket worktree throws instead of being deleted.
  if (fs.existsSync(ticket.worktree)) {
    assertIsTicketWorktree(ticket.worktree);
    fs.rmSync(ticket.worktree, { recursive: true, force: true });
  }

  // Closing a ticket keeps the branch: it is the only record of the work.
  // Only setup rollback discards it, where the branch was just cut and is empty.
  // Dead branches are swept by `glafka lysis <id> --sweep`, which asks first.
  if (discardBranch) {
    try {
      deleteBranch(repoRoot, ticket.branch, { force: true });
    } catch (err) {
      // This message means the branch is not there. Anything else is real.
      const text = `${(err as { stderr?: string; message?: string }).stderr ?? ''}${(err as Error).message ?? ''}`;
      if (!/not found/i.test(text)) throw err;
    }
  }

  // The agent's TMPDIR, outside the repo: nothing else names this path, so skipping it leaks the scratch dir forever.
  // Last and untried on purpose — worktree and branch are already gone, and a non-ticket id should throw, not get rm'd.
  fs.rmSync(ticketScratchPath(ticket.id), { recursive: true, force: true });
}
