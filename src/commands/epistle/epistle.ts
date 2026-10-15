import fs from 'node:fs';
import path from 'node:path';
import {
  push,
  boundedDiff,
  changedFiles,
  commitPaths,
  rebaseOnto,
  createPullRequest,
  openPullRequestForBranch,
  worktreeCheckKey,
  headTree,
  headCommit,
  currentBranch,
  isAncestor,
  pathsChangedSince,
  PullRequestFailedError,
} from '../../util/git.js';
import { checksVerdict, CHECK_VERDICT } from '../../checks.js';
import {
  readTicket,
  readCachedChecks,
  updateTicket,
  recordStage,
  STAGES,
  REVIEW_VERDICT,
  isReviewedSinceLastChange,
  lastStageAt,
  lastReviewFailed,
  lastReviewUnverified,
  assertNotClosed,
  assertLastRunOk,
  refreshVerifiedCode,
  refreshReviewedTree,
  hasUnreviewedCommit,
  UNREVIEWED_COMMIT,
  activeCriteria,
  liveReviewerRoles,
} from '../../ticket/ticketStore.js';
import type { Ticket } from '../../types/ticket.js';
import { DOCS_ROOT, isTidyDoc } from '../../memory/docsStore.js';
import { odysseUpdate as odysseUpdateDefault } from '../odysse/odysse.js';
import {
  cbmAvailable as cbmAvailableDefault,
  cbmQuery as cbmQueryDefault,
} from '../../memory/cbm.js';
import { VERDICT_SOURCE } from '../ergon/ergon.js';
import { assertNoLiveRun } from '../../ticket/background.js';
import {
  assertUnchanged,
  resolvePolicy,
  hostExecWarning,
} from '../../../installKit/guardrails/index.js';
import { resolvePushVerdict } from './utils.js';
import { buildDocSyncPrompt } from './prompts.js';
import { auditIsDue } from '../../memory/ethosAudit/ethosAudit.js';
import { verificationGap, codeState } from '../epalitheusis/epalitheusis.js';

// What `--unreviewed` walked past, written onto the stage log. Each is a different story later:
// nobody looked, the reviewer crashed, the reviewer finished and said nothing anyone can read, or
// the only verdict we have was read out of the reviewer's own text and never recorded through
// `krisis` — a guess we can not tell apart from a coder marking its own work clean.
const BYPASS_NOTE: Readonly<Record<string, string>> = Object.freeze({
  [VERDICT_SOURCE.NOT_DONE]: 'unreviewed',
  [VERDICT_SOURCE.RUN_FAILED]: 'unreviewed (reviewer run failed)',
  [VERDICT_SOURCE.NONE]: 'unreviewed (reviewer recorded no verdict)',
  [VERDICT_SOURCE.LOG_LINE]: 'unreviewed (verdict parsed from text, never recorded)',
});

export interface EpistleResult {
  ticket: Ticket;
  docSyncPrompt: string | null;
  odysseUpdatePrompt: string;
  hostExec: string | null;
  auditDue: { due: boolean; count: number; grown: number };
  // Everything `epistlePush` needs to finish the job, carried across the tidy
  // work that happens between the two halves.
  bypassed: string | null;
}

// A rebase by hand makes new code, and the review and the criteria were about the old code.
const afterHandRebase = (id: string): string =>
  `  after a rebase by hand, run glafka ergon ${id} --review — the new code is checked again`;

// The reviewer read HEAD, and the push sends the ticket's branch by name. A coder that ran
// `git checkout -b` makes those two different, so the push would send code nobody reviewed.
function assertOnTicketBranch(id: string, worktree: string, branch: string): void {
  const onBranch = currentBranch(worktree);
  if (onBranch === branch) return;
  const where = onBranch === 'HEAD' ? 'no branch (a detached HEAD)' : `branch ${onBranch}`;
  throw new Error(
    `ticket ${id} can't be pushed — its worktree is on ${where}, not on ${branch}.\n` +
      `  see it:    git -C ${worktree} status\n` +
      `  then:      move the work back onto ${branch}, review it, and run epistle again`,
  );
}

// The tidy-up agents work in this worktree between the gates and the push. Their job is docs, so a
// branch switch, a rewritten history or a commit of anything but tidy docs is code no gate looked at.
function assertTidyChangedOnlyDocs(ticket: Ticket, commitBeforeTidy: string): void {
  const worktree = ticket.worktree!;
  assertOnTicketBranch(ticket.id, worktree, ticket.branch!);
  if (headCommit(worktree) === commitBeforeTidy) return;
  const rewritten = !isAncestor(worktree, commitBeforeTidy);
  const code = rewritten
    ? []
    : pathsChangedSince(worktree, commitBeforeTidy).filter((file) => !isTidyDoc(file));
  if (!rewritten && code.length === 0) return;
  const what = rewritten
    ? 'rewrote the branch history'
    : `committed more than docs (${code.join(', ')})`;
  throw new Error(
    `ticket ${ticket.id} can't be pushed — something during the tidy-up ${what}.\n` +
      `  see it:    git -C ${worktree} log --oneline ${commitBeforeTidy.slice(0, 12)}..HEAD\n` +
      `  then:      drop those commits and run epistle again, or review them: glafka ergon ${ticket.id} --review`,
  );
}

// Our own rebase or docs commit moved HEAD after the gates held on `from`. The review and
// the criteria were about the code before it, so both move with it.
function followOwnCommit(stateDir: string, id: string, from: string, worktree: string): void {
  const now = codeState(worktree);
  refreshVerifiedCode(stateDir, id, { from, ...now });
  refreshReviewedTree(stateDir, id, { from, tree: now.tree });
}

// Every gate, the rebase, and the tidy-up prompts — but NO push. The prompts point at the ticket's
// own worktree, so the agent writes the branch's docs and `commitTidyDocs` can commit them.
export function epistlePrepare({
  stateDir,
  id,
  repoRoot,
  base = 'main',
  // The one "I am overriding a gate" switch. It used to cover only the review gates, and a separate
  // `--unverified` covered the checks gate — which meant two flags for one idea, and a person could
  // wave past the checks gate while still believing the review gate had held. There is now one flag,
  // and every gate it walked past is named on the ticket and in the PR body.
  unreviewed = false,
  // Only ever used to rebuild the key `glafka checks` saved its results under. Nothing here runs a
  // check — this command reads evidence, it does not gather it.
  checksCmd = null,
  e2eCmd = null,
  cbmAvailable = cbmAvailableDefault,
  cbmQuery = cbmQueryDefault,
  odysseUpdate = odysseUpdateDefault,
}: {
  stateDir: string;
  id: string;
  repoRoot: string;
  base?: string;
  unreviewed?: boolean;
  checksCmd?: string | null;
  e2eCmd?: string | null;
  // Read by `epistlePush`, not here. Declared on this half so `epistle` below
  // can take one options object for the whole command.
  createPr?: typeof createPullRequest;
  findOpenPr?: typeof openPullRequestForBranch;
  cbmAvailable?: typeof cbmAvailableDefault;
  cbmQuery?: typeof cbmQueryDefault;
  odysseUpdate?: typeof odysseUpdateDefault;
}): EpistleResult {
  const ticket = readTicket(stateDir, id);
  assertNotClosed(ticket);
  if (!ticket.worktree || !ticket.branch) {
    throw new Error(`ticket ${id} has no worktree/branch — nothing to push`);
  }
  assertNoLiveRun({
    stateDir,
    id,
    action: 'pushing',
    risk: "rebasing onto a live agent's own commits can produce a broken branch",
  });
  // The step below REWRITES the commits a live reviewer is reading, so its
  // verdict would describe code that no longer exists. Every reviewer, not just the first.
  for (const role of liveReviewerRoles({ stateDir, id, ticket })) {
    assertNoLiveRun({
      stateDir,
      id,
      role,
      action: 'pushing',
      risk: 'rebasing rewrites the very commits a live reviewer is reading, so its verdict would describe a diff that no longer exists',
    });
  }
  assertLastRunOk(ticket, 'pushing');
  // Was this really built under the guardrails we think it was?
  assertUnchanged({ repoRoot, ticket, action: 'push' });

  // `--unreviewed` never skips this: a push from another branch is not this ticket's code.
  assertOnTicketBranch(id, ticket.worktree, ticket.branch);

  // Checked first. "Reviewed" means since the last code change, not ever.
  // `--unreviewed` skips this, and we write that on the ticket.
  const reviewed = isReviewedSinceLastChange(ticket);
  if (!unreviewed && !reviewed) {
    const reviewedAt = lastStageAt(ticket, STAGES.REVIEW);
    const codedAt = lastStageAt(ticket, STAGES.ERGON);
    const why =
      reviewedAt === null
        ? 'it has never been reviewed'
        : hasUnreviewedCommit(ticket)
          ? `the code changed after the last review (${reviewedAt}) — ${UNREVIEWED_COMMIT}`
          : `the last review (${reviewedAt}) is older than the last code change (${codedAt})`;
    throw new Error(
      `ticket ${id} can't be pushed — ${why}.\n` +
        `  review it:      glafka ergon ${id} --review\n` +
        `  or push anyway: glafka epistle ${id} --unreviewed   (recorded on the ticket)`,
    );
  }

  // A ticket can be reviewed and still have failing checks.
  // `--unreviewed` skips the first question, never the second.
  if (lastReviewFailed(ticket)) {
    throw new Error(
      `ticket ${id} can't be pushed — its last review recorded failing checks.\n` +
        `  fix them, then review again: glafka ergon ${id} --review`,
    );
  }

  // The acceptance criteria. `--unreviewed` never skips this: it is about
  // what the app does, not about who read the diff.
  const gap = verificationGap(ticket);
  if (gap) {
    throw new Error(
      `ticket ${id} can't be pushed — ${gap}.\n` +
        `  verify it:                glafka ergon ${id} --review\n` +
        `  or skip one, at a terminal: glafka epalitheusis ${id} --skip AC-<n> --reason "..."\n` +
        afterHandRebase(id),
    );
  }

  // The checks above only prove a review was set up, not that anyone read
  // the diff. This is the real verdict, and a blocking one always stops us.
  const pushVerdict = resolvePushVerdict({ stateDir, id });
  if (pushVerdict.source === VERDICT_SOURCE.NOT_DONE) {
    if (!unreviewed) {
      throw new Error(
        `ticket ${id} can't be pushed — no reviewer has actually looked at this diff yet ` +
          `(or one is still running).\n` +
          `  review it:      glafka ergon ${id} --review\n` +
          `  or push anyway: glafka epistle ${id} --unreviewed   (recorded on the ticket)`,
      );
    }
    // RUN_FAILED and NONE are the reviewer's TOOLING failing, not its judgement: no verdict exists
    // either way. That is the same thing `--unreviewed` already covers, so it covers these too —
    // otherwise a flaky reviewer makes real, checks-green work unpushable by any documented
    // command, and the only remaining exit is lysis, which throws the work away.
  } else if (pushVerdict.source === VERDICT_SOURCE.RUN_FAILED) {
    if (!unreviewed) {
      throw new Error(
        `ticket ${id} can't be pushed — the reviewer process itself failed; that is not a verdict.\n` +
          `  see what happened: glafka ergon ${id} --review --status\n` +
          `  review again:      glafka ergon ${id} --review\n` +
          `  or push anyway:    glafka epistle ${id} --unreviewed   (recorded on the ticket)`,
      );
    }
  } else if (pushVerdict.source === VERDICT_SOURCE.NONE) {
    if (!unreviewed) {
      throw new Error(
        `ticket ${id} can't be pushed — the reviewer finished but recorded nothing readable either way.\n` +
          `  read the log yourself: glafka ergon ${id} --review --status\n` +
          `  review again:         glafka ergon ${id} --review\n` +
          `  or push anyway:       glafka epistle ${id} --unreviewed   (recorded on the ticket)`,
      );
    }
    // A clean read out of the reviewer's own text is a GUESS, not a record. `krisis` proves who
    // said it and that they read this round's diff; a line of text proves neither, so a coder
    // writing "VERDICT: clean" about its own work is indistinguishable from a real reviewer saying
    // it. This used to sail through with no gate and no note at all — the weakest evidence glafka
    // accepts was the only kind it never questioned. Blocking is exempt, for the same reason it is
    // exempt everywhere else: it costs little to trust and stopping is the safe direction.
  } else if (
    pushVerdict.source === VERDICT_SOURCE.LOG_LINE &&
    pushVerdict.verdict === REVIEW_VERDICT.CLEAN
  ) {
    if (!unreviewed) {
      throw new Error(
        `ticket ${id} can't be pushed — the only "clean" we have was parsed out of the reviewer's ` +
          `own text; it never recorded a verdict through glafka krisis, so nothing proves who wrote it.\n` +
          `  see what happened: glafka ergon ${id} --review --status\n` +
          `  review again:      glafka ergon ${id} --review\n` +
          `  or push anyway:    glafka epistle ${id} --unreviewed   (recorded on the ticket and in the PR)`,
      );
    }
    // A blocking verdict is the reviewer's JUDGEMENT, and it is readable. No
    // override: `--unreviewed` means "no verdict exists", never "ignore one".
  } else if (pushVerdict.verdict === REVIEW_VERDICT.BLOCKING) {
    throw new Error(
      `ticket ${id} can't be pushed — its review found a blocking problem` +
        (pushVerdict.finding ? `: ${pushVerdict.finding}` : '') +
        `.\n  fix it, then review again: glafka ergon ${id} --review`,
    );
  }

  // Nothing ran is its own answer, and it used to be pushable on the grounds that many
  // projects have no checks. That let a ticket through having run zero commands. glafka
  // cannot tell "nothing to run" from "we never found the command", so a person says which.
  // `--unreviewed` skips only the "never ran" refusal. Checks that ran and FAILED always block.
  if (lastReviewUnverified(ticket)) {
    // The review's note records what was true when the reviewer ran. Checks run SINCE — by `glafka
    // checks <id>` — are newer evidence about this same commit, so they are read first.
    //
    // Without this the gate could never move. Everything the old message named configured a command
    // without running it: `odysse --checks` writes `checksCmd`, editing .glafka.json writes
    // `checksCmd`, `krisis` records a verdict. None of them re-runs a check, and only `ergon
    // --review` did — at the price of a whole review round. So the first ticket in any project,
    // where `checksCmd` cannot exist before the ticket does, had exactly one exit: the override
    // flag, which stamps the ticket permanently even when every check passes by hand.
    const key = worktreeCheckKey(ticket.worktree, { checksCmd, e2eCmd });
    const recorded = readCachedChecks(ticket, key);
    const recordedVerdict = recorded ? checksVerdict(recorded) : null;

    if (recordedVerdict === CHECK_VERDICT.FAILED) {
      const failed = recorded!
        .filter((check) => !check.passed && !check.unknown)
        .map((c) => c.name);
      throw new Error(
        `ticket ${id} can't be pushed — its checks were run and FAILED (${failed.join(', ')}).\n` +
          `  see the output: glafka checks ${id}\n` +
          `  fix them, then run it again`,
      );
    }

    if (!unreviewed && recordedVerdict !== CHECK_VERDICT.PASSED) {
      throw new Error(
        `ticket ${id} can't be pushed — its checks never ran, so nothing was verified.\n` +
          `  1. make sure there IS a command: glafka odysse --checks   (finds it, once)\n` +
          `     or set "checksCmd" in .glafka.json by hand\n` +
          `  2. then RUN it for this ticket:  glafka checks ${id}   (no LLM, no review round)\n` +
          `  3. then push:                    glafka epistle ${id}\n` +
          `\n` +
          `  Step 2 is the one that moves this gate — step 1 only configures the command.\n` +
          `  Nothing to run at all?  glafka epistle ${id} --unreviewed   (recorded on the ticket and in the PR)`,
      );
    }
  }

  // Which gate `--unreviewed` actually walked past. "unreviewed" alone would
  // hide the difference between "nobody looked" and "the reviewer broke".
  // Only when a review gate was really walked past. Now that one flag opens both gates, a push with
  // a genuine `krisis` clean can carry `--unreviewed` purely for the checks gate — and claiming it
  // skipped the review too would be a lie in the other direction.
  // An old clean verdict has no note of its own. Over newer code it is still a skipped review.
  const staleReview = reviewed ? null : 'unreviewed (code changed after the review)';
  const skippedReview = unreviewed ? (BYPASS_NOTE[pushVerdict.source] ?? staleReview) : null;
  // Both can be true. A push that skipped review AND verified nothing must say both.
  const skippedChecks = unreviewed && lastReviewUnverified(ticket) ? 'unverified' : null;
  const bypassed = [skippedReview, skippedChecks].filter(Boolean).join(', ') || null;

  // The criteria gate held just above. Our own rebase moves the tree, so the record moves with it,
  // or the "retry just the PR" below would be refused as changed code.
  const treeBeforeRebase = headTree(ticket.worktree);
  try {
    rebaseOnto(ticket.worktree, base);
  } catch (err) {
    if (activeCriteria(ticket).length === 0 && !ticket.reviewedTree) throw err;
    throw new Error(`${(err as Error).message}\n${afterHandRebase(id)}`, { cause: err });
  }
  followOwnCommit(stateDir, id, treeBeforeRebase, ticket.worktree);

  // Compare against the same branch we just moved onto. Comparing against
  // the local copy would pull in other people's commits as if they were ours.
  const diffBase = `origin/${base}`;

  // A last check: .env.glafka can hold real passwords,
  // so refuse if it is about to be pushed.
  const paths = changedFiles(ticket.worktree, diffBase);
  if (paths.includes('.env.glafka')) {
    throw new Error(
      `ticket ${id}: .env.glafka is tracked in this branch's diff — it can hold real credentials; ` +
        `untrack it (git rm --cached .env.glafka) before pushing`,
    );
  }

  // Read once and given to BOTH doc prompts. They ask different questions of the same change, and
  // the diff is the most expensive thing either of them carries.
  const docDiff = boundedDiff(ticket.worktree, diffBase);

  let docSyncPrompt: string | null = null;
  if (ticket.planPath) {
    // The branch's own copy of the plan, not the main checkout's. Both exist —
    // it is one repo — and only this one can be committed onto the branch.
    const planPath = inWorktree(ticket.planPath, repoRoot, ticket.worktree);
    docSyncPrompt = buildDocSyncPrompt({
      ticketId: ticket.id,
      planPath,
      // Same reason as the plan: the branch's copy, not the main checkout's.
      specPath: ticket.specPath ? inWorktree(ticket.specPath, repoRoot, ticket.worktree) : null,
      diff: docDiff,
    });
  }

  // When codebase-memory-mcp is installed, detect_changes gives the same
  // information instantly. The existing odysseUpdate path stays as a fallback.
  let odysseUpdatePrompt: string;
  if (cbmAvailable()) {
    odysseUpdatePrompt = cbmQuery(ticket.worktree, 'detect_changes', {
      paths: paths.join(','),
    });
  } else {
    ({ prompt: odysseUpdatePrompt } = odysseUpdate({
      repoRoot: ticket.worktree,
      treeRoot: ticket.worktree,
      changedPaths: paths,
      diff: docDiff,
    }));
  }

  // Changed files that will run on YOUR machine, not in the cage.
  // Worth reading, but it does not block the push.
  const { policy } = resolvePolicy({ repoRoot });
  const hostExec = hostExecWarning(policy, paths);

  // The audit itself writes proposals to state, never to a doc, so it changes
  // nothing anyone has to commit. It rides along for the report only.
  const auditDue = auditIsDue(repoRoot);

  return { ticket, docSyncPrompt, odysseUpdatePrompt, hostExec, auditDue, bypassed };
}

// The same file, in the worktree. Hands the path back unchanged when it is outside `repoRoot`, or
// when the doc was never committed — a worktree only holds what git tracks, so that copy is absent.
function inWorktree(docPath: string, repoRoot: string, worktree: string): string {
  const relative = path.relative(repoRoot, docPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return docPath;
  const inBranch = path.join(worktree, relative);
  return fs.existsSync(inBranch) ? inBranch : docPath;
}

// Commits what the tidy-up agents wrote. Only under the docs root, so a doc commit can never carry
// code. Empty when the docs already matched — a normal, quiet pass, not an empty commit.
export function commitTidyDocs({ ticket }: { ticket: Ticket }): string[] {
  if (!ticket.worktree) return [];
  const commit = commitPaths(
    ticket.worktree,
    [DOCS_ROOT],
    `docs: sync plan and architecture for ${ticket.id}`,
  );
  return commit?.committed ?? [];
}

// The PR body. A bypass used to be written onto the ticket and nowhere else, so the one person it
// was written for — whoever opens the PR — could not see it: on GitHub an overridden push looked
// exactly like a fully verified one. It goes at the TOP, because a reviewer who reads no further
// than the first line still has to see it.
function prBody(ticket: Ticket, bypassed: string | null): string {
  if (!bypassed) return ticket.specText;
  return `> ⚠ **Pushed with \`--unreviewed\`** — gates walked past: ${bypassed}.\n\n${ticket.specText}`;
}

// The second half: push and open the PR. Split from the gates so the tidy-up
// can run in between. Everything that can refuse has already refused.
export function epistlePush({
  stateDir,
  id,
  base = 'main',
  bypassed = null,
  createPr = createPullRequest,
  // Injected so tests can answer for GitHub without one. Real callers never pass it.
  findOpenPr = openPullRequestForBranch,
}: {
  stateDir: string;
  id: string;
  base?: string;
  bypassed?: string | null;
  createPr?: typeof createPullRequest;
  findOpenPr?: typeof openPullRequestForBranch;
}): { ticket: Ticket; prUpdated: boolean } {
  // Re-read: the doc commit above moved HEAD, and the ticket may have been
  // written to while the tidy agents ran.
  const ticket = readTicket(stateDir, id);
  if (!ticket.worktree || !ticket.branch) {
    throw new Error(`ticket ${id} has no worktree/branch — nothing to push`);
  }

  push(ticket.worktree, ticket.branch);

  // Recorded the moment the push lands, BEFORE the PR is attempted. Opening the PR is a separate
  // call to a separate program that fails for its own reasons — not logged in, not installed,
  // remote is not GitHub — and when it did, the branch was already on the remote while the ticket
  // still said it had never been pushed. A user reading `○ pushed` then
  // re-runs the whole rebase looking for the work they already sent.
  recordStage(stateDir, id, STAGES.EPISTLE, bypassed);

  // A markdown spec starts with a heading, and the `#` is not part of the
  // title. Trimmed here rather than in the spec, because the spec is right.
  const title =
    ticket.specText
      .split('\n')[0]
      ?.replace(/^#+\s*/, '')
      .trim() || ticket.id;
  // A branch keeps ONE pull request, and every push after the first belongs to the one already open.
  // `gh pr create` refuses a second, so this used to push the commits and then throw — the work was
  // on GitHub and the command still ended in an error, which reads as "the push failed". Asked of
  // GitHub, not of the ticket: a PR opened by hand is just as real, and the ticket has never heard
  // of it. Nothing is re-sent; the push above already updated it.
  const existing = findOpenPr({ cwd: ticket.worktree, branch: ticket.branch });
  if (existing) {
    updateTicket(stateDir, id, () => ({ prUrl: existing }));
    return { ticket: readTicket(stateDir, id), prUpdated: true };
  }

  let prUrl: string;
  try {
    prUrl = createPr({ cwd: ticket.worktree, title, body: prBody(ticket, bypassed), base });
  } catch (err) {
    if (!(err instanceof PullRequestFailedError)) throw err;
    // Say what did happen before saying what did not. Re-running is safe: the rebase is a no-op, the
    // push is up to date, and the PR is retried — but only if the retry carries the same flag. The
    // hint used to name the bare command, which walks straight back into the gate this push already
    // overrode, so the one situation the hint exists for was the one where it did not work.
    throw new PullRequestFailedError(
      `ticket ${id}: the branch IS pushed (${ticket.branch} → origin), but the pull request was not opened.\n` +
        `  ${err.message.split('\n').join('\n  ')}\n` +
        `  then retry just the PR: glafka epistle ${id}${bypassed ? ' --unreviewed' : ''}`,
    );
  }

  // We update one field under a lock. Writing the whole ticket back would
  // erase anything saved during the minutes of network work above.
  updateTicket(stateDir, id, () => ({ prUrl }));
  // Read it again, so the ticket we return holds the new PR link.
  return { ticket: readTicket(stateDir, id), prUpdated: false };
}

// Gates, tidy-up, then push. `runTidy` is where the agent work goes: the core cannot run an agent,
// so the caller hands in the part that can. Passing nothing gives the gates and the push.
// Awaited, not called and forgotten: the tidy-up runs real agents, and the
// commit below has to see the files they wrote. Fire-and-forget here pushed the
// branch while they were still typing into it.
export async function epistle({
  runTidy = () => {},
  ...options
}: Parameters<typeof epistlePrepare>[0] & {
  runTidy?: (prompts: {
    ticket: Ticket;
    docSyncPrompt: string | null;
    odysseUpdatePrompt: string;
    auditDue: { due: boolean; count: number; grown: number };
  }) => void | Promise<void>;
}): Promise<EpistleResult & { tidyCommitted: string[]; prUpdated: boolean }> {
  const prepared = epistlePrepare(options);
  const worktree = prepared.ticket.worktree!;
  const commitBeforeTidy = headCommit(worktree);
  const treeBeforeTidy = headTree(worktree);
  await runTidy({
    ticket: prepared.ticket,
    docSyncPrompt: prepared.docSyncPrompt,
    odysseUpdatePrompt: prepared.odysseUpdatePrompt,
    auditDue: prepared.auditDue,
  });
  assertTidyChangedOnlyDocs(prepared.ticket, commitBeforeTidy);
  const tidyCommitted = commitTidyDocs({ ticket: prepared.ticket });
  // Same as after the rebase: docs-only commits, the agents' or ours, keep the review and the criteria.
  if (headTree(worktree) !== treeBeforeTidy) {
    followOwnCommit(options.stateDir, options.id, treeBeforeTidy, worktree);
  }
  const { ticket, prUpdated } = epistlePush({
    stateDir: options.stateDir,
    id: options.id,
    base: options.base,
    bypassed: prepared.bypassed,
    createPr: options.createPr,
    findOpenPr: options.findOpenPr,
  });
  return { ...prepared, ticket, tidyCommitted, prUpdated };
}

export { buildDocSyncPrompt };
