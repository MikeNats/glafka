import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  readTicket,
  updateTicket,
  decidePendingCandidates,
  recordStage,
  archiveClosedTicket,
  STAGES,
  assertNotClosed,
  hasOpenPr,
  listTickets,
  liveReviewerRoles,
} from '../../ticket/ticketStore.js';
import { assertNoLiveVerifier } from '../../ticket/liveVerifier.js';
import type { Ticket, EthosCandidate } from '../../types/ticket.js';
import { resolveKeep } from '../../memory/ethosGate.js';
import { releaseResources } from '../../ticket/resources.js';
import { stopDevServerAndWait } from '../../ticket/devServer.js';
import { promoteEthosCandidates } from '../../memory/ethos.js';
import {
  assertNoLiveRun,
  hasRecordedOutcome,
  markOutcomeRecorded,
} from '../../ticket/background.js';
import { TICKET_ID_RE } from '../../ticket/ids.js';
import {
  removeWorktree,
  deleteBranch,
  pullRequestState,
  branchesInUseByWorktrees,
  uncommittedPaths,
} from '../../util/git.js';
import {
  runRolesOnDisk,
  worktreesRoot,
  assertUnderWorktreesRoot,
  listProvisioning,
  isStaleProvisioningLock,
  listFileLocks,
  isStaleFileLock,
} from '../../ticket/paths.js';
import { publishAudit } from '../../audit/publish.js';
import { publishDecisions } from '../../ticket/decisions.js';
import { prState, findOrphanEthosFiles } from './utils.js';
import { clearSessionClaims } from '../../../installKit/guardrails/index.js';

// The real path when the file exists, otherwise the plain resolved one. Used
// wherever a path of ours is compared with a path git reported.
function realish(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

// One flat shape, not a union, because tests look one up by `.kind` and then
// read its fields. Each extra field is only set for the kinds that use it.
export interface Orphan {
  kind: 'worktree' | 'branch' | 'ethosFile' | 'provisioningLock' | 'fileLock';
  label: string;
  detail: string;
  dir?: string;
  branch?: string;
  name?: string;
  id?: string;
  lockPath?: string;
}

// Closes a ticket: gives back its resources and saves the close.
// It only asks about ethos candidates nobody has decided yet.
// Every role that ran, recorded once, whatever anyone did or did not look at.
// hasRecordedOutcome keys on the same per-role marker, so a run already
// recorded is left alone.
function recordUnobservedRuns({
  stateDir,
  id,
  observability,
}: {
  stateDir: string;
  id: string;
  observability: boolean;
}): void {
  if (!observability) return;
  for (const role of runRolesOnDisk(stateDir, id)) {
    if (!hasRecordedOutcome({ stateDir, id, role })) {
      markOutcomeRecorded({ stateDir, id, role, observability });
    }
  }
}

export async function lysis({
  repoRoot,
  stateDir,
  id,
  keep = null,
  prSettled = false,
  force = false,
  observability = false,
  getPrState = pullRequestState,
}: {
  repoRoot: string;
  stateDir: string;
  id: string;
  keep?: string | null;
  prSettled?: boolean;
  force?: boolean;
  // Closing reaps the run files, so this is the last moment any run that
  // nobody observed can still be recorded.
  observability?: boolean;
  getPrState?: typeof pullRequestState;
}): Promise<Ticket & { promoted: EthosCandidate[] }> {
  const ticket = readTicket(stateDir, id);

  // Check this first, so a closed ticket does not cause a GitHub call.
  assertNotClosed(ticket);

  assertNoLiveRun({
    stateDir,
    id,
    action: 'closing',
    risk: 'tearing down a worktree a live agent is still writing to will corrupt it',
  });
  // The check above only looks at the coder, which is fine for reading. Deleting is different, so we
  // check every reviewer the round recorded — the literal "reviewer" missed the second one entirely.
  for (const role of liveReviewerRoles({ stateDir, id, ticket })) {
    assertNoLiveRun({
      stateDir,
      id,
      role,
      action: 'closing',
      risk: 'deleting the worktree a live reviewer is reading loses its verdict, and its process fails for a reason no log explains',
    });
  }
  assertNoLiveVerifier({
    stateDir,
    id,
    action: 'closing',
    risk: 'deleting the worktree a live QA tester is testing loses its results',
  });

  // Ask GitHub if the PR is still open. Do not guess.
  // A crashed last run does NOT block closing. That is a normal reason to close.
  let prCheckSkipped = false;
  if (hasOpenPr(ticket)) {
    const state = prState({ repoRoot, ticket, getPrState, prSettled });
    prCheckSkipped = state === null;
    if (state === 'OPEN') {
      // The override is named here, not only in the source. This is the one moment anyone needs
      // `--pr-settled`, and it appeared in no document
      // — so someone whose PR is merged on a host `gh` cannot read had no way out but `--force`,
      // which throws work away.
      throw new Error(
        `ticket ${id}'s PR is still open (${ticket.prUrl}) — merge or close it on GitHub first, ` +
          `then run lysis again.\n` +
          `  already settled, and gh just can't see it?  glafka lysis ${id} --pr-settled`,
      );
    }
  }

  // Work that was never committed dies with the worktree, and no reflog holds it. lysis is the one
  // command here with no undo, so it is the one that must ask. Checked before anything is deleted.
  if (!force && ticket.worktree) {
    const dirty = uncommittedPaths(ticket.worktree);
    if (dirty.length > 0) {
      const shown = dirty.slice(0, 20);
      const more = dirty.length - shown.length;
      throw new Error(
        `ticket ${id} has ${dirty.length} uncommitted change(s) in its worktree — closing deletes ` +
          `the worktree, and nothing brings these back. The branch is kept, so anything ` +
          `committed survives; only the changes below are lost:\n` +
          shown.map((line) => `  ${line}`).join('\n') +
          (more > 0 ? `\n  … and ${more} more` : '') +
          `\n\nKeep it:    git -C ${ticket.worktree} add -A && git -C ${ticket.worktree} commit -m "wip"\n` +
          `Throw away: glafka lysis ${id} --force`,
      );
    }
  }

  // Do this before we delete anything, so a refusal here
  // does not leave the worktree already gone.
  const { pending, keepIndexes } = resolveKeep({ ticket, keep, command: 'lysis' });

  // Order matters. teardownCmd runs before we delete the worktree,
  // because it needs to run inside it.
  if (!ticket.worktree || !ticket.branch) {
    throw new Error(`ticket ${id} has no worktree/branch — nothing to release`);
  }
  await releaseResources({
    repoRoot,
    stateDir,
    ticket: { ...ticket, worktree: ticket.worktree, branch: ticket.branch },
  });

  // Promote FIRST, decide (write the ticket) second. Promoting can throw (invalid categories.json, an unwritable docs/glafka/ethos/, ...), and
  const toPromote = pending.filter((_candidate, i) => keepIndexes.includes(i + 1));
  promoteEthosCandidates(repoRoot, toPromote);

  // Read the ticket again, so we write onto the current state,
  // not the older copy from above.
  const { kept } =
    pending.length > 0 ? decidePendingCandidates(stateDir, id, keepIndexes) : { kept: [] };

  // Locked read-modify-write — a raw writeTicket here could clobber a concurrent krisis/aporia write from a live agent.
  updateTicket(stateDir, id, () => ({}));
  // Note it if we skipped the PR check, so the closed ticket
  // does not look checked when it was not.
  recordStage(stateDir, id, STAGES.LYSIS, prCheckSkipped ? 'pr-settled' : null);
  // Moves the files to tickets/closed/, so listing open tickets stays fast. Any session that claimed
  // this ticket is done with it. Left behind, a session id the harness later reuses would inherit a cage for finished work.
  clearSessionClaims({ stateDir, ticketId: id });
  // BEFORE the archive, which deletes runsDir. A run nobody asked the status
  // of has its files reaped here, and with them any chance of recording it.
  recordUnobservedRuns({ stateDir, id, observability });
  // The gap between the last row and the archive is the only moment where the
  // numbers are complete and nothing is still writing. This copy is what
  // survives a fresh clone; everything under .glafka/ does not.
  publishAudit({ repoRoot, stateDir, ticketId: id });
  // What was said out loud and settled. Same one-write-at-close rule.
  publishDecisions({ repoRoot, stateDir, ticketId: id });
  archiveClosedTicket(stateDir, id);
  // `promoted` is usually empty, because review decided most of it already.
  return { ...readTicket(stateDir, id), promoted: kept };
}

// Finds leftovers on disk that belong to no ticket.
// It only finds them. A human deletes them one at a time.
export function findOrphans({
  repoRoot,
  stateDir,
  bootstrapTimeoutMs,
}: {
  repoRoot: string;
  stateDir: string;
  bootstrapTimeoutMs?: number;
}): {
  orphanWorktrees: string[];
  orphanBranches: string[];
  orphanEthosFiles: string[];
  orphans: Orphan[];
} {
  // Active means not closed yet. A closed ticket's files should be gone, so anything still on disk counts as a leftover.
  const unreadable: string[] = [];
  const activeTickets = listTickets(stateDir, {
    includeClosed: false,
    onUnreadable: (warning) => unreadable.push(warning),
  });
  if (unreadable.length > 0) {
    throw new Error(
      `refusing to sweep — ${unreadable.length} ticket file(s) could not be read, so the list ` +
        `of what's still active is incomplete and a delete built on it could destroy live work:\n` +
        unreadable.map((w) => `  ${w}`).join('\n') +
        `\n  fix or remove the broken ticket file(s), then try again.`,
    );
  }
  // Only a ticket that RECORDS a worktree protects the directory named after it. A
  // ticket killed mid-setup has neither, and its 120MB checkout was unreachable.
  const activeIds = new Set(activeTickets.filter((t) => t.worktree).map((t) => t.id));
  // We compare the whole branch name, never a piece of it. Branch names are
  // not always "glafka/<id>", so cutting one up would flag real branches.
  const activeBranches = new Set(activeTickets.map((t) => t.branch).filter(Boolean));
  // A ticket still being set up has no file yet, so without these locks its new worktree would look abandoned. Setup can take minutes.
  const provisioningEntries = listProvisioning(stateDir);
  const activeProvisioning = provisioningEntries.filter(
    (e) => !isStaleProvisioningLock(e, { bootstrapTimeoutMs }),
  );
  const staleProvisioning = provisioningEntries.filter((e) =>
    isStaleProvisioningLock(e, { bootstrapTimeoutMs }),
  );
  const provisioningIds = new Set(activeProvisioning.map((e) => e.id));
  const provisioningBranches = new Set(activeProvisioning.map((e) => e.branch).filter(Boolean));

  const worktreesDir = worktreesRoot(repoRoot);
  const orphanWorktrees = fs.existsSync(worktreesDir)
    ? fs
        .readdirSync(worktreesDir)
        .filter((name) => !activeIds.has(name) && !provisioningIds.has(name))
    : [];

  const branchesOut = execFileSync(
    'git',
    ['branch', '--list', 'glafka/*', '--format=%(refname:short)'],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  // Git's own answer to "is a checkout standing on this branch", which the ticket files cannot
  // give. A branch whose ticket file disagrees with what the worktree really checked out is not in
  // `activeBranches`, so without this it is proposed for deletion while a live coder is committing
  // to it. Worktrees are purged before branches in the same sweep, so
  // `git branch -D` refusing is not a backstop we can lean on. Held by an ORPHAN worktree does not
  // count: that checkout is on this very list and gets removed first, which frees the branch.
  // Excluding those too would strand every orphan branch forever, which is the whole job. Compared
  // as REAL paths. git reports a worktree by its resolved path, and on macOS /var is a link to
  // /private/var — so `path.resolve` alone makes every orphan worktree look like a different
  // directory from the one git named, and its branch then gets excluded from the sweep instead of
  // included. Same reason guardrails/core.ts resolves before comparing.
  const purgedWorktreePaths = new Set(
    orphanWorktrees.map((dir) => realish(path.join(worktreesDir, dir))),
  );
  const heldByLiveWorktree = new Map(
    [...branchesInUseByWorktrees(repoRoot)].filter(
      ([, worktree]) => !purgedWorktreePaths.has(realish(worktree)),
    ),
  );
  const orphanBranches = branchesOut
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((branch) => !activeBranches.has(branch) && !provisioningBranches.has(branch))
    .filter((branch) => !heldByLiveWorktree.has(branch));

  const orphanEthosFiles = findOrphanEthosFiles(repoRoot);

  // A write lock whose owner died. Nothing else would ever remove it,
  // and every later write to that ticket would fail.
  const fileLocks = listFileLocks(stateDir);
  const staleFileLocks = fileLocks.filter((e) => !e.corrupt && isStaleFileLock(e));
  // A lock that names nobody cannot be judged by ownerIsGone at all, so it can never become "stale" and
  // nothing would ever clear it. Listing it is the point: a human deleting it is the model every other orphan already uses.
  const corruptFileLocks = fileLocks.filter((e) => e.corrupt);

  // Worktrees come before branches, because git will not delete a branch
  // that a worktree is still using.
  const orphans: Orphan[] = [
    ...orphanWorktrees.map((dir): Orphan => ({
      kind: 'worktree',
      dir,
      label: `.worktrees/${dir}`,
      detail: 'checkout left on disk',
    })),
    ...orphanBranches.map((branch): Orphan => ({
      kind: 'branch',
      branch,
      label: branch,
      detail: 'local branch with no ticket',
    })),
    ...orphanEthosFiles.map((name): Orphan => ({
      kind: 'ethosFile',
      name,
      label: `docs/glafka/ethos/${name}`,
      detail: 'category gone from categories.json, so nothing reads it',
    })),
    ...staleProvisioning.map((e): Orphan => ({
      kind: 'provisioningLock',
      id: e.id,
      lockPath: e.lockPath,
      label: `.glafka/tickets/${e.id}.provisioning`,
      detail:
        'stale provisioning lock (dead process or past the bootstrap timeout) — its worktree/branch are listed above as ordinary orphans now',
    })),
    ...staleFileLocks.map((e): Orphan => ({
      kind: 'fileLock',
      id: e.id,
      lockPath: e.lockPath,
      label: `.glafka/tickets/${e.id}.lock`,
      detail:
        'stale write lock (its holder process died mid-write) — every future write to this ticket would otherwise fail',
    })),
    ...corruptFileLocks.map((e): Orphan => ({
      kind: 'fileLock',
      id: e.id,
      lockPath: e.lockPath,
      label: `.glafka/tickets/${e.id}.lock`,
      detail:
        'lock file is empty or unreadable — no owner can be identified, so nothing can ever judge it stale and every future write to this ticket would fail',
    })),
  ];

  return { orphanWorktrees, orphanBranches, orphanEthosFiles, orphans };
}

// Deletes ONE leftover. There is no delete-all on purpose.
// The caller decides item by item.
export async function purgeOrphan({
  repoRoot,
  stateDir,
  orphan,
}: {
  repoRoot: string;
  // Where the app's pid file lives. Without it there is no app to stop.
  stateDir: string;
  orphan: Orphan;
}): Promise<void> {
  switch (orphan.kind) {
    case 'worktree': {
      if (orphan.dir === undefined) throw new Error('orphan.dir missing for kind "worktree"');
      const dir = path.join(worktreesRoot(repoRoot), orphan.dir);
      // Before the checkout goes: an app left running holds this ticket's ports.
      // Only a folder named like a ticket can have one — runs are keyed by that.
      if (TICKET_ID_RE.test(orphan.dir)) {
        try {
          await stopDevServerAndWait({ stateDir, id: orphan.dir });
        } catch (err) {
          // A leftover nobody can delete is worse than a process to kill by
          // hand, so a failed stop is said out loud and the sweep carries on.
          console.error(
            `warning: the app for ${orphan.dir} could not be stopped, so it may still be ` +
              `running: ${(err as Error).message}`,
          );
        }
      }
      try {
        removeWorktree(repoRoot, dir, { force: true });
      } catch {
        // Not a real git worktree, so just delete the folder.
        // The guard only checks that it sits inside .worktrees.
        assertUnderWorktreesRoot(repoRoot, dir);
        fs.rmSync(dir, { recursive: true, force: true });
        try {
          execFileSync('git', ['worktree', 'prune'], { cwd: repoRoot, stdio: 'ignore' });
        } catch {
          // Fine either way. The folder is already gone.
        }
      }
      return;
    }
    case 'branch': {
      if (orphan.branch === undefined) throw new Error('orphan.branch missing for kind "branch"');
      // Asked again at delete time, not trusted from the listing. The list can be minutes old, and `-D` is
      // not recoverable. A worktree created since the sweep ran is exactly the case the listing cannot know about.
      const holder = branchesInUseByWorktrees(repoRoot).get(orphan.branch);
      if (holder) {
        throw new Error(
          `refusing to delete branch "${orphan.branch}" — the worktree at ${holder} is checked out ` +
            `on it, so deleting it throws away work that checkout still holds. ` +
            `Remove that worktree first, then sweep again.`,
        );
      }
      deleteBranch(repoRoot, orphan.branch, { force: true });
      return;
    }
    case 'ethosFile':
      if (orphan.name === undefined) throw new Error('orphan.name missing for kind "ethosFile"');
      fs.rmSync(path.join(repoRoot, 'docs/glafka/ethos', orphan.name), { force: true });
      return;
    case 'provisioningLock':
    case 'fileLock':
      if (orphan.lockPath === undefined) {
        throw new Error(`orphan.lockPath missing for kind "${orphan.kind}"`);
      }
      fs.rmSync(orphan.lockPath, { force: true });
      return;
    default:
      throw new Error(`unknown orphan kind "${orphan.kind}" — refusing to guess how to delete it`);
  }
}
