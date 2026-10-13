import { ROLES } from '../../types/ticket.js';
import fs from 'node:fs';
import { withFileLock } from '../../util/fileOperations.js';
import { runFiles } from '../../ticket/paths.js';
import {
  readTicket,
  recordStage,
  readCachedChecks,
  saveCachedChecks,
  liveReviewerRoles,
  startCleanRound,
  STAGES,
  assertNotClosed,
  assertLastRunOk,
  lastRunOutcome,
  consumeVerifyRound,
  activeCriteria,
  VERIFY_OUTCOME,
  setReviewedTree,
} from '../../ticket/ticketStore.js';
import { assertNoLiveVerifier } from '../../ticket/liveVerifier.js';
import { loadPromptContext } from '../../memory/context.js';
import { readStandards, readReviewDoc } from '../../memory/standards.js';
import {
  spawnBackground,
  assertNoLiveRun,
  markExternalRunFinished,
} from '../../ticket/background.js';
import { runChecks, checksVerdict, explainNoChecks, CHECK_VERDICT } from '../../checks.js';
import { readBaseline, splitFailures } from '../../checksBaseline.js';
import {
  assertUnchanged,
  resolvePolicy,
  hostExecWarning,
  hostExecBlocking,
  type Policy,
} from '../../../installKit/guardrails/index.js';
import { verifyGate, prepareVerify, checkMadeLines } from '../epalitheusis/epalitheusis.js';
import type { VerifyPrepared } from '../epalitheusis/epalitheusis.js';
import { routeReview, explainRoute, roleFor } from './router.js';
import type { ReviewerKind } from './router.js';
import {
  worktreeCheckKey,
  branchDiff,
  diffStat,
  changedFiles,
  uncommittedPaths,
  headTree,
} from '../../util/git.js';
import { glafkaCli } from '../../util/cli.js';
import { readProgress, OUTCOME_FOR_VERDICT } from './utils.js';
import { buildReviewPrompt } from './prompts.js';
import type { Ticket } from '../../types/ticket.js';
import type { CheckResult } from '../../types/checks.js';

// --------------------------------------------------------------------------- Final review step — `ergon <id> --review`

// One reviewer this round earned. `prompt` is the copy printed for a human to paste; `reviewerPrompt`
// is the one that carries this round's token and is only ever handed to a real spawned reviewer.
export interface ReviewerAssignment {
  kind: ReviewerKind;
  role: string;
  prompt: string;
  reviewerPrompt: string;
}

export interface ReviewPrepared {
  ticket: Ticket;
  diff: string;
  checks: CheckResult[];
  checksNote: string | null;
  hostExec: string | null;
  reviewToken: string;
  // Every reviewer this diff earned, in dispatch order.
  reviewers: ReviewerAssignment[];
  // Why it earned them, in one line. No LLM.
  routeNote: string;
  // The first reviewer's prompts, repeated. Every caller that existed before fan-out reads these two,
  // and a diff that earns one reviewer must behave exactly as it always did. They are always reviewers[0].
  prompt: string;
  reviewerPrompt: string;
  // Set when the acceptance criteria must be checked first. Then `reviewers` is empty.
  verify: VerifyPrepared | null;
}

// Why the review stopped, as a type, not as words in a message. Matching on words would break the next time the wording changes.
export class CoderFixableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoderFixableError';
  }
}

// An acceptance criterion failed. A coder can fix it, and it is held to maxReviewRounds
// like a blocking review: a coder whose work no round may check is money spent for nothing.
export class AcceptanceFailedError extends CoderFixableError {
  constructor(message: string) {
    super(message);
    this.name = 'AcceptanceFailedError';
  }
}

// Checks are failing, but every one of them was failing before this ticket existed. Deliberately NOT
// a CoderFixableError: vima routes that to a fresh coder, and a coder cannot fix a script it never wrote.
export class PreExistingChecksError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreExistingChecksError';
  }
}

export class NothingToReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NothingToReviewError';
  }
}

// The acceptance criteria stopped the round, and no coder can fix it. A person must look.
export class VerifyBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VerifyBlockedError';
  }
}

// A manual QA round still lacks results. Like "nothing to review", it uses up no round.
export class VerifyStillOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VerifyStillOpenError';
  }
}

// Reads the committed diff and never touches the worktree,
// so more than one reviewer can read it at the same time.
export async function ergonReview({
  stateDir,
  id,
  repoRoot,
  baseRef = 'main',
  checksCmd = null,
  e2eCmd = null,
  checksTimeoutMs = null,
  e2eTimeoutMs = null,
  personaContent = null,
  // The project's own review document, if its config names one. Reviewer-only.
  reviewDoc = null,
  // A person at a real terminal: an open manual QA round starts again with a fresh token.
  restartManualRound = false,
}: {
  stateDir: string;
  id: string;
  repoRoot: string;
  baseRef?: string;
  checksCmd?: string | null;
  e2eCmd?: string | null;
  checksTimeoutMs?: number | null;
  e2eTimeoutMs?: number | null;
  personaContent?: string | null;
  reviewDoc?: string | null;
  restartManualRound?: boolean;
}): Promise<ReviewPrepared> {
  const ticket = readTicket(stateDir, id);
  assertNotClosed(ticket);

  // We record the review entry exactly once, even if the round fails early.
  // That count is the only thing stopping the fix loop running forever.
  let reviewRecorded = false;
  const recordReviewOnce = (note: string | null, flags: { qaBlocked?: boolean } = {}): void => {
    if (reviewRecorded) return;
    reviewRecorded = true;
    recordStage(stateDir, id, STAGES.REVIEW, note, flags);
  };

  try {
    return await prepareReview({
      stateDir,
      id,
      repoRoot,
      ticket,
      baseRef,
      checksCmd,
      e2eCmd,
      checksTimeoutMs,
      e2eTimeoutMs,
      personaContent,
      reviewDoc,
      restartManualRound,
      recordReviewOnce,
    });
  } catch (err) {
    // "Nothing to review" must not use up a round. It is a full stop, so
    // charging it would only take a try away from the human restarting it.
    if (!(err instanceof NothingToReviewError) && !(err instanceof VerifyStillOpenError)) {
      recordReviewOnce(lastRunOutcome(ticket));
    }
    throw err;
  }
}

async function prepareReview({
  stateDir,
  id,
  repoRoot,
  ticket,
  baseRef,
  checksCmd,
  e2eCmd,
  checksTimeoutMs,
  e2eTimeoutMs,
  personaContent,
  reviewDoc,
  restartManualRound,
  recordReviewOnce,
}: {
  stateDir: string;
  id: string;
  repoRoot: string;
  ticket: Ticket;
  baseRef: string;
  checksCmd: string | null;
  e2eCmd: string | null;
  checksTimeoutMs: number | null;
  e2eTimeoutMs: number | null;
  personaContent: string | null;
  reviewDoc: string | null;
  restartManualRound: boolean;
  recordReviewOnce: (note: string | null, flags?: { qaBlocked?: boolean }) => void;
}): Promise<ReviewPrepared> {
  if (!ticket.worktree) {
    throw new NothingToReviewError(`ticket ${id} has no worktree — nothing to review`);
  }
  // The same gate ergon and epistle have. A reviewer spawned under a policy nobody accepted reads a
  // diff built under a different one, and its clean verdict is what epistle then trusts.
  assertUnchanged({ repoRoot, ticket, action: 'review' });
  // Asking for a review is the coder saying it stopped coding. For a run glafka spawned this
  // changes nothing (the call is a no-op while a pid file exists); for one dispatched into
  // someone's own session it is the terminator that path never had, so the run stops reading as
  // "running" forever.
  markExternalRunFinished({ stateDir, id, role: ROLES.CODER });
  assertNoLiveRun({
    stateDir,
    id,
    action: 'reviewing',
    risk: 'reading a diff out from under a live agent can catch it mid-commit',
  });
  // A live QA tester is a round still open, not a failed one: it uses up no review round.
  try {
    assertNoLiveVerifier({
      stateDir,
      id,
      action: 'reviewing',
      risk: 'the QA tester is still checking the acceptance criteria; a new round would throw its results away',
    });
  } catch (err) {
    throw new VerifyStillOpenError((err as Error).message);
  }
  // A second guard. We are about to clear findings for a new round, which would lose data if the
  // last reviewer is still reading. Every role the ticket recorded, not the literal "reviewer" — a
  // second reviewer was invisible to every liveness guard.
  for (const role of liveReviewerRoles({ stateDir, id, ticket })) {
    assertNoLiveRun({
      stateDir,
      id,
      role,
      action: 'reviewing',
      risk: 'a live reviewer is still reading the previous round; starting a new one would clear its findings out from under it',
    });
  }
  // A bad last run is worth another coder, because more code can fix it.
  try {
    assertLastRunOk(ticket, 'reviewing');
  } catch (err) {
    throw new CoderFixableError((err as Error).message);
  }

  // Reuses ergon's key, so the checks run once, not twice.
  const key = worktreeCheckKey(ticket.worktree, { checksCmd, e2eCmd });

  // Counts changed files instead of reading the whole diff,
  // so a huge branch can not choke this.
  if (diffStat(ticket.worktree, baseRef).files === 0) {
    throw new NothingToReviewError(`ticket ${id} has no commits vs ${baseRef} — nothing to review`);
  }

  // The check above is against the base BRANCH, and glafka's own `.gitignore` commit sits between
  // the two — so a coder that committed absolutely nothing still had a one-line diff, and a real,
  // paid reviewer was dispatched to read glafka's own bookkeeping.
  // `planCommit` is that commit, so counting from it is the honest measure of what this
  // ticket produced. Null progress means there is no starting point recorded (a heureka worktree),
  // and then the branch diff above is all we have.
  const sinceApproval = readProgress(ticket, baseRef);
  if (sinceApproval && sinceApproval.commits === 0) {
    throw new NothingToReviewError(
      `ticket ${id} has no commits of its own since the plan was approved — nothing to review.\n` +
        (sinceApproval.uncommittedChanges
          ? `  its worktree HAS uncommitted changes: the coder wrote code and never committed it, and\n` +
            `  a review reads \`git diff ${baseRef}...HEAD\`, so none of it would be looked at.\n` +
            `  see it:  git -C ${ticket.worktree} status\n`
          : `  the coder produced nothing. Its log says what happened:\n` +
            `  glafka ergon ${id} --status\n`),
    );
  }

  // Step 2's state, read before anything is cleared. An open round changes nothing, or
  // every vima tick would notify again while it waits for a person.
  let gate = verifyGate({ stateDir, id });
  // A manual round's token is printed once. A person may start it again, with a fresh one.
  const now = readTicket(stateDir, id);
  if (gate.kind === 'running' && restartManualRound && now.verification?.spawned === false) {
    gate = { kind: 'start', criteria: activeCriteria(now) };
  }
  if (gate.kind === 'running') {
    throw new VerifyStillOpenError(
      `ticket ${id}: the QA round is still open — no result yet for ${gate.missing.join(', ')}.\n` +
        `  record one:  glafka epalitheusis ${id} --ac <AC-n> --result pass|fail|cannot --evidence "..."\n` +
        `  then:        glafka ergon ${id} --review --status\n` +
        `  lost the token of a manual round? run glafka ergon ${id} --review at a real terminal`,
    );
  }

  // A new round starts clean, with its own review token; a "clean" without it is not trusted.
  // A QA round does this where it really opens (dispatchVerifier, openManualRound).
  const reviewToken = gate.kind === 'start' ? '' : startCleanRound(stateDir, id);
  // Only a review round drops the old tree. A QA round adds no review entry, so it keeps it.
  if (gate.kind !== 'start') setReviewedTree(stateDir, id, null);

  // Computed before the checks run, not after: the npm fallback below would otherwise run package.json's own scripts on the host, unattended,
  const { policy } = resolvePolicy({ repoRoot });
  const changed = changedFiles(ticket.worktree, baseRef);
  const hostExec = hostExecWarning(policy, changed);
  const untrustedPackageJson = changed.includes('package.json');

  const cached = readCachedChecks(ticket, key);
  // What the checks leave behind (a build cache) is glafka's doing, not the coder's.
  const beforeChecks = uncommittedPaths(ticket.worktree);
  const checks =
    cached ??
    (await runChecks(ticket.worktree, {
      checksCmd,
      e2eCmd,
      checksTimeoutMs,
      e2eTimeoutMs,
      untrustedPackageJson,
      hostExecutingChanges: hostExecBlocking(policy, changed),
    }));
  if (!cached) saveCachedChecks(stateDir, id, key, checks);
  const checkMade = checkMadeLines(
    beforeChecks,
    uncommittedPaths(ticket.worktree),
    readTicket(stateDir, id).verification?.checkMade ?? [],
  );

  const verdict = checksVerdict(checks);
  const checksOutcome = OUTCOME_FOR_VERDICT[verdict];
  // A failing check is saved first: everything below that line can throw.
  if (verdict === CHECK_VERDICT.FAILED) recordReviewOnce(checksOutcome);

  // If checks fail, a reviewer has nothing useful to add, so stop here.
  // UNKNOWN passes through, since many projects have no checks at all.
  if (verdict === CHECK_VERDICT.FAILED) {
    // Who caused each failure. A check that was ALREADY red on the base commit is not this ticket's
    // doing, and no number of coder rounds can fix it — that is the money this used to burn.
    // With no baseline recorded, everything counts as introduced, which is the
    // old behaviour.
    const { introduced, preExisting } = splitFailures(
      checks,
      ticket.planCommit ? readBaseline(stateDir, ticket.planCommit) : null,
    );

    // Nothing new broke. Sending the coder here is the waste, so we stop and
    // ask for the one thing that actually fixes it: the real checks command.
    if (introduced.length === 0) {
      throw new PreExistingChecksError(
        `ticket ${id}: the only failing check(s) — ${preExisting.join(', ')} — were ALREADY ` +
          `failing on this ticket's base commit (${ticket.planCommit?.slice(0, 7)}), ` +
          `before any code was written here. Nobody configured them; glafka ran them because ` +
          `package.json defines them. A coder cannot fix what it did not break.\n` +
          `  see the failure:   glafka ergon ${id} --status\n` +
          `  set the real one:  "checksCmd" in .glafka.json, or glafka odysse --checks\n` +
          `  or fix the base:   they are broken on ${baseRef} too`,
      );
    }

    // Only the ones this branch introduced. Naming a pre-existing failure here
    // would send the coder chasing it.
    const alsoNote =
      preExisting.length > 0
        ? `\n  (ignoring ${preExisting.join(', ')} — already failing on the base commit)`
        : '';
    throw new CoderFixableError(
      `ticket ${id}: checks failed (${introduced.join(', ')}) — fix them before requesting review.${alsoNote}\n` +
        `  see the failure:  glafka ergon ${id} --status\n` +
        `  then re-run:      glafka ergon ${id} --review`,
    );
  }

  // Step 2: the acceptance criteria, before any reviewer reads the diff.
  if (gate.kind === 'start') {
    // No review entry: nothing was reviewed, and vima reads that entry.
    return {
      ticket,
      diff: '',
      checks,
      checksNote: null,
      hostExec,
      reviewToken,
      reviewers: [],
      routeNote: `${gate.criteria.length} acceptance criteria — a QA tester checks them before any reviewer`,
      prompt: '',
      reviewerPrompt: '',
      verify: prepareVerify({ ticket, repoRoot, criteria: gate.criteria, checkMade }),
    };
  }
  if (gate.kind === 'blocked') {
    // Still a round, so maxReviewRounds counts it. Marked, so nobody reads the last reviewer's
    // verdict as this round's.
    recordReviewOnce(checksOutcome, { qaBlocked: true });
    consumeVerifyRound(stateDir, id, gate.tokenHash);
    if (gate.outcome === VERIFY_OUTCOME.FAILED) {
      throw new AcceptanceFailedError(
        `ticket ${id}: acceptance criteria failed — ${gate.detail}\n` +
          `  fix them and commit, then re-run:  glafka ergon ${id} --review`,
      );
    }
    // A dirty pass is "passed" too: its detail already says what is wrong.
    const ended =
      gate.outcome === VERIFY_OUTCOME.PASSED
        ? gate.detail
        : `the QA round ended ${gate.outcome} — ${gate.detail}`;
    throw new VerifyBlockedError(
      `ticket ${id}: ${ended}\n` +
        `  see it:            glafka ergon ${id} --review --status\n` +
        `  check again:       glafka ergon ${id} --review\n` +
        `  or skip one (you): glafka epalitheusis ${id} --skip AC-<n> --reason "..."`,
    );
  }
  // The exact code this reviewer reads. epistle refuses a push once HEAD moves past it. Saved
  // before the review entry: a crash between the two then leaves "not reviewed", never "reviewed".
  setReviewedTree(stateDir, id, headTree(ticket.worktree));
  recordReviewOnce(checksOutcome);

  const diff = branchDiff(ticket.worktree, baseRef);

  // Only when nothing ran. A reviewer told "no checks ran" needs the reason,
  // or it looks like a pass.
  const checksNote =
    verdict === CHECK_VERDICT.UNKNOWN && checks.length === 0
      ? explainNoChecks(ticket.worktree)
      : null;

  // The reviewer has a real diff, so its scoped rules match exact files.
  // Standards and the project's own review doc are added HERE and not in loadPromptContext:
  // that function feeds the coder too, and these two are reviewer-only by design.
  const context = {
    ...loadPromptContext({ repoRoot, worktree: ticket.worktree, paths: changed }),
    personaContent,
    standards: readStandards(repoRoot),
    reviewDoc: readReviewDoc(repoRoot, reviewDoc),
  };

  // How many reviewers this diff earned. Git facts only, no tokens spent.
  const facts = diffStat(ticket.worktree, baseRef);
  const kinds = routeReview(facts);
  const routeNote = explainRoute(facts, kinds);

  // Two prompts per reviewer, not one. `prompt` never carries the token — it is the one printed to
  // the coder's own stdout when no separate A general reviewer working alone still
  // gets the codebase map. It only gives it up when an architecture reviewer is reading structure
  // anyway.
  const paired = kinds.length > 1;
  const promptKind = (kind: ReviewerKind): string =>
    kind === 'general' && paired ? 'general-paired' : kind;

  const cli = glafkaCli(repoRoot);
  const reviewers: ReviewerAssignment[] = kinds.map((kind, i) => ({
    kind,
    role: roleFor(i),
    prompt: buildReviewPrompt({
      ticket,
      diff,
      baseRef,
      checks,
      checksNote,
      hostExec,
      context,
      kind: promptKind(kind),
      cli,
    }),
    reviewerPrompt: buildReviewPrompt({
      ticket,
      diff,
      baseRef,
      checks,
      checksNote,
      hostExec,
      reviewToken,
      context,
      kind: promptKind(kind),
      cli,
    }),
  }));

  const first = reviewers[0]!;
  return {
    ticket,
    diff,
    checks,
    checksNote,
    hostExec,
    reviewToken,
    reviewers,
    routeNote,
    prompt: first.prompt,
    reviewerPrompt: first.reviewerPrompt,
    verify: null,
  };
}

// Starts the review as its own process, so it is a real fresh reviewer.
// It takes a ready prompt, so many tickets can be prepared first.
export function dispatchReviewer({
  stateDir,
  ticket,
  prompt,
  agentCmd,
  policy = null,
  role = ROLES.REVIEWER,
}: {
  stateDir: string;
  ticket: Pick<Ticket, 'id' | 'worktree'>;
  prompt: string;
  agentCmd: string;
  policy?: Policy | null;
  // Which reviewer slot this is. The first keeps the plain "reviewer" name.
  role?: string;
}): ReturnType<typeof spawnBackground> {
  // Same race as ergonBackground, same fix: the check and the spawn must happen as one step, or two overlapping callers can both
  const { dir: runDir, lockPath } = runFiles(stateDir, ticket.id, role);
  fs.mkdirSync(runDir, { recursive: true });
  return withFileLock(lockPath, () => {
    // Per ROLE, not per ticket. Two reviewers of the same round run side by side on purpose; two runs in
    // the same slot would waste one and make the verdict ambiguous.
    assertNoLiveRun({
      stateDir,
      id: ticket.id,
      role,
      action: 'reviewing',
      risk: 'starting a second reviewer over the same one would waste the run and confuse the verdict',
    });
    return spawnBackground({
      stateDir,
      id: ticket.id,
      role,
      agentCmd,
      prompt,
      cwd: ticket.worktree,
      policy,
    });
  });
}
