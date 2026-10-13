import {
  readTicket,
  listTickets,
  STAGES,
  lastStageIndex,
  lastStageAt,
  isClosed,
  isCancelled,
  describeTicket,
  hasOpenPr,
  hasUnreviewedCommit,
  UNREVIEWED_COMMIT,
} from '../../ticket/ticketStore.js';
import { backgroundStatus } from '../../ticket/background.js';
import { ROLES } from '../../types/ticket.js';
import { devServerAlive } from '../../ticket/devServer.js';
import { readIsolationProfile } from '../../memory/docsStore.js';
import { ticketCommitMessages } from '../../util/git.js';
import { readProgress, ergonReviewStatus, VERDICT_SOURCE } from '../ergon/ergon.js';
import {
  SYMBOL,
  RUN_ACTIVE,
  currentChecksOutcome,
  checksLine,
  verdictLine,
  summaryFor,
} from './utils.js';
import type { PoreiaView } from './utils.js';

// Where a ticket is right now. It only reads what is already on disk,
// so it is instant. It never guesses a fact we did not save.

export { SYMBOL };
export type { PoreiaView };

// Whether this project has an app at all. A profile we cannot read is not the
// dashboard's problem, so it reads as "no app" rather than throwing.
function hasDevCmd(repoRoot: string | null): boolean {
  if (!repoRoot) return false;
  try {
    return Boolean(readIsolationProfile(repoRoot)?.devCmd);
  } catch {
    return false;
  }
}

// repoRoot is optional, because a caller that does not pass it simply gets no
// app line. Without it there is no profile to read, so there is nothing to say.
export function poreia({
  stateDir,
  id,
  repoRoot = null,
  // The base branch. Without it the commit list widens to include commits
  // merged in FROM that branch, which are not this ticket's steps.
  baseRef = null,
}: {
  stateDir: string;
  id: string;
  repoRoot?: string | null;
  baseRef?: string | null;
}): PoreiaView {
  const ticket = readTicket(stateDir, id);
  const coder = backgroundStatus({ stateDir, id, role: ROLES.CODER });
  // Null when there is no approved plan to count from,
  // or when the worktree is gone.
  const progress = readProgress(ticket, baseRef);
  // A result here means the worktree and the plan commit are both set.
  const steps = progress ? ticketCommitMessages(ticket.worktree!, ticket.planCommit!, baseRef) : [];
  const review = ergonReviewStatus({ stateDir, id });

  return {
    id: ticket.id,
    title: ticket.title,
    position: describeTicket(ticket),
    closed: isClosed(ticket),
    cancelled: isCancelled(ticket),
    specWritten: Boolean(ticket.specPath),
    planned: Boolean(ticket.planPath),
    // A worktree but no plan means this ticket is exploring on purpose.
    exploring: Boolean(ticket.worktree) && !ticket.planPath,
    coder,
    progress,
    steps,
    aporia: ticket.aporia ?? null,
    reviewRequested: lastStageIndex(ticket, STAGES.REVIEW) !== -1,
    reviewedAt: lastStageAt(ticket, STAGES.REVIEW),
    unreviewedCommit: hasUnreviewedCommit(ticket),
    checksOutcome: currentChecksOutcome(ticket),
    // Only read, never started. This is the command people run to look.
    devRunning: hasDevCmd(repoRoot) ? devServerAlive({ stateDir, id: ticket.id }) : null,
    review,
    pushed: hasOpenPr(ticket),
    branchPushed: lastStageIndex(ticket, STAGES.EPISTLE) !== -1,
    prUrl: ticket.prUrl,
  };
}

export function poreiaAll({
  stateDir,
  repoRoot = null,
  baseRef = null,
}: {
  stateDir: string;
  repoRoot?: string | null;
  baseRef?: string | null;
}): PoreiaView[] {
  return listTickets(stateDir).map((t) => poreia({ stateDir, id: t.id, repoRoot, baseRef }));
}

// -------------------------------------------------------------------------- Drawing — kept apart from the data, so the display can change freely.

// The full checklist for one ticket. It stops early if the ticket is done.
// The type is partial, because each branch only needs a few fields.
export function renderPoreia(view: Partial<PoreiaView>): string {
  const lines = [`${view.id}  ${view.title ?? '(no title yet)'}`, ''];

  if (view.cancelled) {
    lines.push(`  ${SYMBOL.DONE} cancelled`);
    return lines.join('\n');
  }
  if (view.closed) {
    lines.push(`  ${SYMBOL.DONE} closed`);
    if (view.pushed) lines.push(`  ${SYMBOL.DONE} pushed  ${view.prUrl}`);
    return lines.join('\n');
  }

  lines.push(`  ${view.specWritten ? SYMBOL.DONE : SYMBOL.PENDING} spec written`);

  // Null means this project has no app, and then nothing is said at all.
  if (view.devRunning === true) lines.push(`  ${SYMBOL.DONE} app running`);
  if (view.devRunning === false) lines.push(`  ${SYMBOL.PENDING} app not running`);

  if (view.exploring) {
    lines.push(`  ${SYMBOL.DONE} exploring — no fixed plan (heureka)`);
  } else {
    lines.push(`  ${view.planned ? SYMBOL.DONE : SYMBOL.PENDING} plan approved`);
  }

  // Only the branches above return without these fields.
  // Anything that reaches this line has them set.
  const coder = view.coder!;
  const steps = view.steps!;
  const coderActive = RUN_ACTIVE.has(coder.state);
  const hasCommits = steps.length > 0;
  // Being stuck wins. A coder that stopped on purpose looks finished,
  // so showing "done" here would be wrong.
  const implementSymbol = view.aporia
    ? SYMBOL.NEEDS_YOU
    : coderActive
      ? SYMBOL.RUNNING
      : hasCommits
        ? SYMBOL.DONE
        : SYMBOL.PENDING;
  const commitWord = steps.length === 1 ? 'commit' : 'commits';
  lines.push(
    `  ${implementSymbol} implement${hasCommits ? `  ${steps.length} ${commitWord}` : ''}`,
  );
  for (const subject of steps) lines.push(`      ${SYMBOL.DONE} ${subject}`);
  if (view.progress?.uncommittedChanges) {
    lines.push(`      uncommitted changes present — a step may have been interrupted mid-way`);
  }

  // Stop here as well. A person is needed before anything else happens.
  if (view.aporia) {
    lines.push(`  ${SYMBOL.NEEDS_YOU} needs you — ${view.aporia.reason}`);
    return lines.join('\n');
  }

  const checks = checksLine(view.checksOutcome ?? null);
  if (checks) lines.push(`  ${checks.symbol} ${checks.label}`);

  if (view.reviewRequested) {
    // This flag is only true once there is a real review to report.
    const review = view.review!;
    // A round is only done when every reviewer it started is done.
    const total = review.total ?? 1;
    const back = review.back ?? (RUN_ACTIVE.has(review.status.state) ? 0 : 1);
    // The state string is printed on this same line, so the symbol has to come from it too. Reading
    // the count alone printed the RUNNING symbol beside `run=not-started` — a round can exist with
    // 0 of 1 back and no reviewer ever launched, and the line then contradicted itself.
    const reviewSymbol = !RUN_ACTIVE.has(review.status.state)
      ? review.status.state === 'not-started'
        ? SYMBOL.PENDING
        : SYMBOL.DONE
      : back < total
        ? SYMBOL.RUNNING
        : SYMBOL.DONE;
    // Only say "of N" when there is more than one. One reviewer is the
    // common case and does not need counting.
    const count = total > 1 ? `  ${back} of ${total} back` : '';
    lines.push(`  ${reviewSymbol} review  run=${review.status.state}${count}`);

    const verdict = verdictLine(review);
    if (verdict) lines.push(`  ${verdict.symbol} ${verdict.label}`);

    // The line above already says what the verdict is worth, and this one used to disagree with it:
    // a verdict only PARSED out of the reviewer's text drew `⚠` there and a plain `✔ ready for you`
    // directly underneath, which is the half a person reads. Both halves answer to the same rule
    // now — nothing but a recorded clean is ready for anybody.
    const clean =
      review.verdict.source === VERDICT_SOURCE.KRISIS && review.verdict.verdict === 'clean';
    if (view.unreviewedCommit) {
      lines.push(
        `  ${SYMBOL.NEEDS_YOU} ${UNREVIEWED_COMMIT} — review it: glafka ergon ${view.id} --review`,
      );
    } else {
      lines.push(`  ${clean ? SYMBOL.DONE : SYMBOL.PENDING} ready for you`);
    }
  } else {
    lines.push(`  ${SYMBOL.PENDING} review`);
    lines.push(`  ${SYMBOL.PENDING} ready for you`);
  }

  if (view.pushed) {
    lines.push(`  ${SYMBOL.DONE} pushed  ${view.prUrl}`);
  } else if (view.branchPushed) {
    // The push landed and the PR did not. Saying "not pushed" here sent people
    // re-running the whole rebase looking for work already on the remote.
    lines.push(`  ${SYMBOL.DONE} branch pushed — but no PR was opened`);
    lines.push(`      retry just the PR:  glafka epistle ${view.id}`);
  } else {
    lines.push(`  ${SYMBOL.PENDING} pushed`);
  }

  return lines.join('\n');
}

export function renderPoreiaAll(views: Partial<PoreiaView>[]): string {
  if (views.length === 0) return 'no active tickets';
  return views
    .map(summaryFor)
    .sort((a, b) => a.rank - b.rank)
    .map((s) => s.text)
    .join('\n');
}
