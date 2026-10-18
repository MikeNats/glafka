import type { Stage, Ticket } from './contract';
import type { GlafkaTicket } from './schemas';
import { personSteps, qaDoneOf, qaWaits, waitsOf } from './waits';

// What the ticket alone does not say: the glafka command, and whether a QA agent is set.
export interface TicketContext {
  bin: string;
  hasVerifier: boolean;
}
const DEFAULT_CONTEXT: TicketContext = { bin: 'glafka', hasVerifier: true };

const ACTIVE = new Set(['running', 'stalled', 'timed-out']);
const BUILDER: Record<string, Ticket['builder']> = {
  running: 'running',
  stalled: 'stalled',
  'timed-out': 'stalled',
  finished: 'done',
  failed: 'failed',
  crashed: 'failed',
};

function reviewOf(g: GlafkaTicket): Ticket['review'] {
  const findings = g.review.findings.flatMap((f) =>
    f.verdict === 'blocking' && f.finding ? [f.finding] : [],
  );
  const { verdict, source } = g.review.verdict;
  // Only a verdict glafka recorded counts as clean; one read from the reviewer's text does not.
  if (source === 'krisis' && verdict === 'clean') return { state: 'clean', findings };
  if (findings.length > 0 || verdict === 'blocking') return { state: 'blocking', findings };
  return { state: ACTIVE.has(g.review.status.state) ? 'running' : 'none', findings };
}

function qaOf(g: GlafkaTicket): Ticket['qa'] {
  const results: Ticket['qa']['results'] = (g.qa?.results ?? []).map((r) => ({
    id: r.id,
    result: r.result === 'pass' || r.result === 'fail' ? r.result : 'cannot',
    evidence: r.evidence,
  }));
  if (!g.qa) return { state: 'none', results };
  if (g.qa.outcome === null) return { state: 'running', results };
  return { state: g.qa.outcome === 'passed' ? 'passed' : 'failed', results };
}

// glafka says "ready for you" once the review is clean, before QA. Ready here waits for QA.
function stageOf(g: GlafkaTicket, review: Ticket['review'], qa: Ticket['qa']): Stage {
  if (g.cancelled) return 'cancelled';
  if (g.closed) return 'closed';
  if (g.pushed) return 'pushed';
  if (ACTIVE.has(g.coder.state)) return 'building';
  if (review.state === 'running') return 'reviewing';
  if (qa.state === 'running') return 'testing';
  const qaDone = qaDoneOf(g, qa);
  if (g.summary.text.includes('ready for you')) return qaDone ? 'ready' : 'testing';
  if (review.state === 'clean' && !qaDone) return 'testing';
  if (g.planned) return g.steps.length > 0 ? 'building' : 'planned';
  return g.specPath ? 'planning' : 'new';
}

const withoutId = (g: GlafkaTicket) =>
  (g.summary.text.startsWith(g.id) ? g.summary.text.slice(g.id.length) : g.summary.text).trim();

// The line for tooltips and the bar. While QA is still to come, glafka's own line says
// "ready for you", which is not true yet.
function summaryOf(g: GlafkaTicket, stage: Stage, qa: Ticket['qa'], byHand: boolean): string {
  if (stage !== 'testing' || !g.summary.text.includes('ready for you')) return withoutId(g);
  if (qa.state !== 'running') return 'review clean — QA has not checked it yet';
  return byHand
    ? 'review clean — a check by hand is open'
    : 'QA is checking the acceptance criteria';
}

// One glafka ticket in Elaia's own shape.
export function toTicket(g: GlafkaTicket, ctx: TicketContext = DEFAULT_CONTEXT): Ticket {
  const review = reviewOf(g);
  const qa = qaOf(g);
  const stage = stageOf(g, review, qa);
  // An open round with no QA agent is a person checking by hand: nothing runs.
  const byHand = qa.state === 'running' && !ctx.hasVerifier;
  // glafka ranks a QA run as nothing running; it is running.
  const working = g.summary.rank === 1 || (qa.state === 'running' && !byHand);
  const facts = { stage, working, byHand, hasVerifier: ctx.hasVerifier, qa };
  const waits = waitsOf(g) ?? qaWaits(g, facts);
  return {
    id: g.id,
    title: g.title,
    created: g.created ?? null,
    stage,
    summary: summaryOf(g, stage, qa, byHand),
    working,
    waitsForYou: waits,
    builder: BUILDER[g.coder.state] ?? 'idle',
    commits: g.steps,
    checks:
      g.checksOutcome === 'ok' ? 'passed' : g.checksOutcome === 'checks-failed' ? 'failed' : null,
    review,
    criteria: g.criteria,
    qa,
    personSteps: personSteps(g, waits, ctx.bin),
    started: g.planned,
    specPath: g.specPath,
    planPath: g.planPath,
    worktree: g.worktree,
    branch: g.branch,
    prUrl: g.prUrl,
  };
}
