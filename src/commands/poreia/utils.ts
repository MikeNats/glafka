import {
  STAGES,
  lastStageIndex,
  lastRunOutcome,
  lastReviewOutcome,
  RUN_OUTCOMES,
  UNREVIEWED_COMMIT,
} from '../../ticket/ticketStore.js';
import { VERDICT_SOURCE } from '../ergon/ergon.js';
import type { Ticket } from '../../types/ticket.js';

export const SYMBOL = Object.freeze({
  DONE: '✔',
  RUNNING: '⣾',
  PENDING: '○',
  NEEDS_YOU: '⚠',
  FAILED: '✗',
  UNKNOWN: '?',
});

export const RUN_ACTIVE = new Set(['running', 'stalled', 'timed-out']);

// Loose shapes on purpose. Drawing only reads a few simple fields, and the
// tests build these by hand, which a stricter type would reject.
export interface ReviewSummary {
  status: { state: string };
  findings: { verdict: string; finding?: string | null }[];
  verdict: { source: string; verdict?: string | null; finding?: string | null };
  // How many of this round's reviewers have finished. A big diff earns more than one, and "the reviewer
  // is done" is the wrong thing to say when another is still reading. Absent on tickets from before fan-out.
  back?: number;
  total?: number;
}

// The full state of one ticket, as we report it. It lives here so this
// file does not have to import from the file that builds it.
export interface PoreiaView {
  id: string;
  title: string | null;
  position: string;
  closed: boolean;
  cancelled: boolean;
  specWritten: boolean;
  planned: boolean;
  exploring: boolean;
  coder: { state: string };
  progress: { commits?: number; latestCommit?: string | null; uncommittedChanges?: boolean } | null;
  steps: string[];
  aporia: { reason: string; at?: string } | null;
  reviewRequested: boolean;
  reviewedAt: string | null;
  // Reviewed, then a commit by hand. epistle refuses it, so this view must not say "ready".
  unreviewedCommit: boolean;
  checksOutcome: string | null;
  // Null when this project has no app to run.
  devRunning: boolean | null;
  review: ReviewSummary;
  pushed: boolean;
  // The branch reached the remote, but no PR was opened — `gh` failed, or is not installed, or the
  // remote is not GitHub. Distinct from `pushed`, which means there is a PR.
  branchPushed: boolean;
  prUrl: string | null;
}

// Picks the newest check result.
// Once a review exists, its result is newer, so it wins.
export function currentChecksOutcome(ticket: Ticket): string | null {
  if (lastStageIndex(ticket, STAGES.REVIEW) !== -1) return lastReviewOutcome(ticket);
  return lastRunOutcome(ticket);
}

export function checksLine(outcome: string | null): { symbol: string; label: string } | null {
  if (outcome === null) return null;
  if (outcome === RUN_OUTCOMES.OK) return { symbol: SYMBOL.DONE, label: 'checks green' };
  // NEEDS_YOU, not UNKNOWN. `?` reads as "we are not sure", and a ticket that finished having run
  // zero commands read as clean because of it. Naming the consequence is the useful half: epistle
  // refuses this, so it is a thing to act on rather than a shrug.
  if (outcome === RUN_OUTCOMES.CHECKS_UNKNOWN) {
    return {
      symbol: SYMBOL.NEEDS_YOU,
      label: 'checks UNVERIFIED — nothing ran, so this cannot be pushed',
    };
  }
  // A run you stopped yourself is not a failure to investigate. Same symbol as
  // "waiting on you", because that is what it is: the next move is yours.
  if (outcome === RUN_OUTCOMES.CANCELLED) {
    return { symbol: SYMBOL.NEEDS_YOU, label: 'stopped by you — nothing was verified' };
  }
  // Covers failed, timed out and crashed. We name the real one.
  return { symbol: SYMBOL.FAILED, label: `checks ${outcome}` };
}

// Draws the verdict as one line. Silence is never shown as clean.
export function verdictLine(review: ReviewSummary): { symbol: string; label: string } | null {
  const { verdict, findings } = review;
  switch (verdict.source) {
    case VERDICT_SOURCE.KRISIS:
    case VERDICT_SOURCE.LOG_LINE: {
      if (verdict.verdict === 'clean') {
        // A clean read out of the reviewer's own text is a guess, and this line used to draw it with
        // the same ✔ as a verdict recorded through `krisis`. `--status` said "not trusted alone"
        // about the very same data — so the honest command was the one nobody checks, and poreia,
        // the one everybody checks, was the confident one. A guess is a thing to look at, not a
        // thing to be done with, so it ranks as needs-you and never reads "ready for you".
        return verdict.source === VERDICT_SOURCE.LOG_LINE
          ? {
              symbol: SYMBOL.NEEDS_YOU,
              label: "verdict: clean — but PARSED from the reviewer's text, never recorded",
            }
          : { symbol: SYMBOL.DONE, label: 'verdict: clean' };
      }
      const blocking = findings.filter((f) => f.verdict === 'blocking');
      const detail = blocking[0]?.finding ?? verdict.finding ?? null;
      return {
        symbol: SYMBOL.NEEDS_YOU,
        label: `verdict: blocking${detail ? ` — ${detail}` : ''}`,
      };
    }
    case VERDICT_SOURCE.NONE:
      return {
        symbol: SYMBOL.UNKNOWN,
        label: 'verdict: unparseable — reviewer recorded nothing readable',
      };
    case VERDICT_SOURCE.RUN_FAILED:
      // `cancelled` reads as an event, not a fault — "the reviewer process
      // cancelled" would sound like the reviewer decided something.
      return review.status.state === 'cancelled'
        ? { symbol: SYMBOL.NEEDS_YOU, label: 'reviewer stopped by you — no verdict' }
        : { symbol: SYMBOL.FAILED, label: `reviewer process ${review.status.state}` };
    case VERDICT_SOURCE.NOT_DONE:
    default:
      return null;
  }
}

// One line per ticket. Needs-you comes first, then live work, then the rest.
// The type is partial, because each caller only fills the fields it needs.
export function summaryFor(view: Partial<PoreiaView>): { rank: number; text: string } {
  if (view.cancelled) return { rank: 3, text: `${view.id}  cancelled` };
  if (view.closed) return { rank: 3, text: `${view.id}  closed` };
  if (view.aporia) {
    return { rank: 0, text: `${view.id}  ${SYMBOL.NEEDS_YOU} needs you  — ${view.aporia.reason}` };
  }

  if (view.unreviewedCommit) {
    return { rank: 0, text: `${view.id}  ${SYMBOL.NEEDS_YOU} needs you  — ${UNREVIEWED_COMMIT}` };
  }

  if (view.reviewRequested) {
    // This flag is only true once there is a real review to report.
    const review = view.review!;
    const verdict = verdictLine(review);
    if (verdict && (verdict.symbol === SYMBOL.NEEDS_YOU || verdict.symbol === SYMBOL.UNKNOWN)) {
      return { rank: 0, text: `${view.id}  ${SYMBOL.NEEDS_YOU} needs you  — ${verdict.label}` };
    }
    if (verdict && verdict.symbol === SYMBOL.DONE) {
      return { rank: 0, text: `${view.id}  ${SYMBOL.DONE} ready for you  — clean` };
    }
    // Still running if ANY reviewer this round is still reading.
    const total = review.total ?? 1;
    const back = review.back ?? (RUN_ACTIVE.has(review.status.state) ? 0 : 1);
    if (back < total) {
      const count = total > 1 ? `  ${back} of ${total} back` : '';
      return {
        rank: 1,
        text: `${view.id}  ${SYMBOL.RUNNING} review  run=${review.status.state}${count}`,
      };
    }
  }

  if (view.checksOutcome === RUN_OUTCOMES.CHECKS_FAILED) {
    return { rank: 0, text: `${view.id}  ${SYMBOL.NEEDS_YOU} needs you  — checks failed` };
  }

  // Only the branches above return without these fields.
  // Anything that reaches this line has them set.
  if (RUN_ACTIVE.has(view.coder!.state)) {
    const n = view.steps!.length;
    return {
      rank: 1,
      text: `${view.id}  ${SYMBOL.RUNNING} implement${n ? `  ${n} commit(s)` : ''}`,
    };
  }

  return { rank: 2, text: `${view.id}  ${view.position}` };
}
