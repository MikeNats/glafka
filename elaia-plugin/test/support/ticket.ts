import type { GlafkaTicket } from '../../src/schemas';

// A full, valid ticket as `glafka poreia --json` prints it. Override what a test cares about.
export function makeGlafkaTicket(overrides: Partial<GlafkaTicket> = {}): GlafkaTicket {
  return {
    id: '2026-10-13-add-csv-export',
    title: 'add csv export',
    position: 'planned',
    closed: false,
    cancelled: false,
    planned: true,
    coder: { state: 'not-started' },
    steps: [],
    aporia: null,
    checksOutcome: null,
    reviewRequested: false,
    review: {
      status: { state: 'not-started' },
      findings: [],
      verdict: { source: 'not-done', verdict: null, finding: null },
    },
    pushed: false,
    prUrl: null,
    worktree: null,
    branch: null,
    specPath: 'docs/glafka/tickets/2026-10-13-add-csv-export/spec.md',
    planPath: 'docs/glafka/tickets/2026-10-13-add-csv-export/plan.md',
    stages: [],
    criteria: [],
    qa: null,
    summary: { rank: 2, text: '2026-10-13-add-csv-export  planned' },
    ...overrides,
  };
}
