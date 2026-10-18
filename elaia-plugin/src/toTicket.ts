import type { Stage, Ticket } from './contract';
import type { GlafkaTicket } from './schemas';
import { activeCriteria, NO_QA_AGENT, personSteps, waitsOf } from './waits';

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

// QA passed on this code: its round opened after the last coder run. glafka keeps an old pass
// until a new round opens, and refuses to push on it.
function qaPassedNow(g: GlafkaTicket, qa: Ticket['qa']): boolean {
  if (qa.state !== 'passed') return false;
  const opened = g.qa?.openedAt;
  const lastCoder = g.stages
    .filter((s) => s.stage === 'ergon')
    .map((s) => s.at)
    .sort()
    .at(-1);
  return !opened || !lastCoder || opened >= lastCoder;
}

// glafka says "ready for you" once the review is clean, before QA. Ready here waits for QA.
function stageOf(g: GlafkaTicket, review: Ticket['review'], qa: Ticket['qa']): Stage {
  if (g.cancelled) return 'cancelled';
  if (g.closed) return 'closed';
  if (g.pushed) return 'pushed';
  if (ACTIVE.has(g.coder.state)) return 'building';
  if (review.state === 'running') return 'reviewing';
  if (qa.state === 'running') return 'testing';
  const qaDone = activeCriteria(g).length === 0 || qaPassedNow(g, qa);
  if (g.summary.text.includes('ready for you')) return qaDone ? 'ready' : 'testing';
  if (review.state === 'clean' && !qaDone) return 'testing';
  if (g.planned) return g.steps.length > 0 ? 'building' : 'planned';
  return g.specPath ? 'planning' : 'new';
}

const withoutId = (g: GlafkaTicket) =>
  (g.summary.text.startsWith(g.id) ? g.summary.text.slice(g.id.length) : g.summary.text).trim();

// The line for tooltips and the bar. While QA is still to come, glafka's own line says
// "ready for you", which is not true yet.
function summaryOf(g: GlafkaTicket, stage: Stage, qa: Ticket['qa']): string {
  if (stage !== 'testing' || !g.summary.text.includes('ready for you')) return withoutId(g);
  return qa.state === 'running'
    ? 'QA is checking the acceptance criteria'
    : 'review clean — QA has not checked it yet';
}

// One glafka ticket in Elaia's own shape.
export function toTicket(g: GlafkaTicket, ctx: TicketContext = DEFAULT_CONTEXT): Ticket {
  const review = reviewOf(g);
  const qa = qaOf(g);
  const stage = stageOf(g, review, qa);
  // glafka ranks a QA run as nothing running; it is running.
  const working = g.summary.rank === 1 || qa.state === 'running';
  const noAgent = stage === 'testing' && !working && !ctx.hasVerifier;
  const waits = waitsOf(g) ?? (noAgent ? NO_QA_AGENT : null);
  return {
    id: g.id,
    title: g.title,
    created: g.created ?? null,
    stage,
    summary: summaryOf(g, stage, qa),
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
