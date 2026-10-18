import { z } from 'zod';
import { TokenRowSchema } from './contract';

// What `glafka poreia --json` reports per ticket. Response schemas stay loose:
// unknown fields are dropped, never rejected, so a newer glafka still parses.
const StageSchema = z.object({ at: z.string(), stage: z.string(), note: z.string().nullable() });

const FindingSchema = z.object({
  verdict: z.string(),
  finding: z.string().nullable().optional(),
});

const ReviewSchema = z.object({
  status: z.object({ state: z.string() }),
  findings: z.array(FindingSchema),
  verdict: z.object({
    source: z.string(),
    verdict: z.string().nullable().optional(),
    finding: z.string().nullable().optional(),
  }),
});

const QaSchema = z.object({
  outcome: z.string().nullable(),
  openedAt: z.string().nullable().optional(),
  results: z.array(
    z.object({ id: z.string(), result: z.string(), evidence: z.string(), verified: z.boolean() }),
  ),
});

export const GlafkaTicketSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  position: z.string(),
  closed: z.boolean(),
  cancelled: z.boolean(),
  planned: z.boolean(),
  coder: z.object({ state: z.string() }),
  steps: z.array(z.string()),
  aporia: z.object({ reason: z.string() }).nullable(),
  checksOutcome: z.string().nullable(),
  reviewRequested: z.boolean(),
  review: ReviewSchema,
  pushed: z.boolean(),
  prUrl: z.string().nullable(),
  worktree: z.string().nullable(),
  branch: z.string().nullable(),
  specPath: z.string().nullable(),
  planPath: z.string().nullable(),
  stages: z.array(StageSchema),
  criteria: z.array(z.object({ id: z.string(), text: z.string() })),
  // Criteria a person chose not to check. An older glafka does not print it.
  criteriaSkips: z.array(z.object({ id: z.string() })).optional(),
  qa: QaSchema.nullable(),
  summary: z.object({ rank: z.number(), text: z.string() }),
  // When glafka made the ticket. An older glafka does not print it.
  created: z.string().nullable().optional(),
});
export type GlafkaTicket = z.infer<typeof GlafkaTicketSchema>;

export const PoreiaJsonSchema = z.object({
  contract: z.literal(1),
  tickets: z.array(GlafkaTicketSchema),
});

export const VimaJsonSchema = z.object({
  contract: z.literal(1),
  results: z.array(z.object({ id: z.string(), action: z.string(), reason: z.string().optional() })),
});

export const CreateJsonSchema = z.object({ contract: z.literal(1), id: z.string() });

// One row per ticket of `glafka audit --json`. Cache fields arrived in audit schema 3.
export const AuditSummarySchema = z.object({
  schema: z.number(),
  tickets: z.array(TokenRowSchema),
});
