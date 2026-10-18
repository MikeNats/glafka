import { z } from 'zod';
// A ticket id goes into paths and commands: letters, digits and . _ - only, no "..".
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const isSafeName = (name: string) =>
  name.length <= 200 && SAFE_NAME.test(name) && !name.includes('..');

// Where a ticket is, in plain software words. Every workflow tool's plugin maps to these.
export const STAGES = [
  'new',
  'planning',
  'planned',
  'building',
  'checking',
  'reviewing',
  'testing',
  'ready',
  'pushed',
  'closed',
  'cancelled',
] as const;
export type Stage = (typeof STAGES)[number];

export const BUILDER_STATES = ['idle', 'running', 'stalled', 'done', 'failed'] as const;

const QaResultSchema = z.object({
  id: z.string(),
  result: z.enum(['pass', 'fail', 'cannot']),
  evidence: z.string(),
});

// One ticket, the same shape for every tool. "ready" means review clean and QA done.
export const TicketSchema = z.object({
  // Ticket ids go into paths, block rules and tool commands: only safe names.
  id: z.string().refine(isSafeName, 'not a safe ticket id'),
  title: z.string().nullable(),
  created: z.string().nullable(),
  stage: z.enum(STAGES),
  // The tool's own one line about the ticket, for tooltips.
  summary: z.string(),
  // A background run is on now.
  working: z.boolean(),
  // Why the tool stopped and waits for you; null when it does not.
  waitsForYou: z.string().nullable(),
  builder: z.enum(BUILDER_STATES),
  commits: z.array(z.string()),
  checks: z.enum(['passed', 'failed']).nullable(),
  review: z.object({
    state: z.enum(['none', 'running', 'clean', 'blocking']),
    findings: z.array(z.string()),
  }),
  criteria: z.array(z.object({ id: z.string(), text: z.string() })),
  qa: z.object({
    state: z.enum(['none', 'running', 'passed', 'failed']),
    results: z.array(QaResultSchema),
  }),
  // Steps only a person may do, at a terminal. Elaia types the command; you press Enter.
  personSteps: z.array(z.object({ label: z.string(), command: z.string() })).default([]),
  // Work began: the worktree is made and the plan is registered.
  started: z.boolean(),
  specPath: z.string().nullable(),
  planPath: z.string().nullable(),
  worktree: z.string().nullable(),
  branch: z.string().nullable(),
  prUrl: z.string().nullable(),
});
export type Ticket = z.infer<typeof TicketSchema>;

export const isEnded = (t: Ticket) => t.stage === 'closed' || t.stage === 'cancelled';

// Tokens the tool's background runs spent on one ticket.
export const TokenRowSchema = z.object({
  ticket: z.string(),
  runs: z.number(),
  durationMs: z.number().nullable(),
  tokensIn: z.number().nullable(),
  tokensOut: z.number().nullable(),
  tokensCacheRead: z.number().nullable().optional(),
  tokensCacheWrite: z.number().nullable().optional(),
});
export type TokenRow = z.infer<typeof TokenRowSchema>;

// Tokens one chat thread spent, summed over its turns.
export interface ChatTokens {
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
}

// What the tool did when asked for a ticket's next step.
export const NextEventSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('started'),
    what: z.enum(['review', 'qa', 'fix']),
    reason: z.string().optional(),
  }),
  z.object({ kind: z.literal('waits'), reason: z.string() }),
  z.object({ kind: z.literal('error'), reason: z.string() }),
  z.object({ kind: z.literal('other'), text: z.string() }),
]);
export type NextEvent = z.infer<typeof NextEventSchema>;

// A background run that ended. `role` is build, review or qa; `key` names this one run.
export const FinishedRunSchema = z.object({
  role: z.string(),
  key: z.string(),
  startedAt: z.string(),
  log: z.string(),
  exitCode: z.number().nullable(),
  // The run's own closing words, for the details.
  lastWords: z.string().nullable(),
});
export type FinishedRun = z.infer<typeof FinishedRunSchema>;
