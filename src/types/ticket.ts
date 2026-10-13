import { z } from 'zod';
import { CheckResultSchema } from './checks.js';
import { TicketGuardrailsPinSchema } from '../../installKit/guardrails/types/pin.js';
import { VerificationSchema, CriterionSkipSchema } from './verification.js';

export type {
  VerifyResult,
  VerifyResultKind,
  Verification,
  VerifyOutcome,
  CriterionSkip,
} from './verification.js';

// These lists are written out by hand. Building them from ticketStore.ts would make this file import the very file that imports it.
export type Stage =
  'create' | 'spec' | 'genesis' | 'plan' | 'ergon' | 'review' | 'epistle' | 'lysis' | 'cancel';
export type RunOutcome =
  | 'ok'
  | 'checks-failed'
  | 'checks-unknown'
  | 'timed-out'
  | 'crashed'
  // Someone stopped this run on purpose. Recorded apart from `crashed` so a
  // deliberate stop never reads as a failure nobody chose.
  | 'cancelled';

// Who an agent run is. Also the folder name under runs/, so the strings
// are on disk and cannot be renamed freely.
export const ROLES = Object.freeze({
  CODER: 'coder',
  REVIEWER: 'reviewer',
  REPORTER: 'reporter',
  VERIFIER: 'verifier',
});
// Review fan-out numbers the extra reviewers, so the real domain is wider
// than the names above — see roleFor() in commands/ergon/router.ts.
export type Role = (typeof ROLES)[keyof typeof ROLES] | `reviewer-${number}`;

// Roles also arrive off a ticket file, which a person can edit. A shape we
// do not know is not recorded, rather than recorded as something it is not.
const ROLE_RE = /^(coder|reporter|verifier|reviewer(-\d+)?)$/;
export function isRole(value: string): value is Role {
  return ROLE_RE.test(value);
}

export interface StageLogEntry {
  at: string;
  stage: Stage;
  note: string | null;
  // Only on a `review` entry: the QA round stopped it, so no reviewer ran.
  qaBlocked?: boolean;
}

// We check the shape here, because a ticket file on disk may be old or hand-edited. The defaults match what writing a ticket already does.

const EthosCandidateSchema = z.object({
  status: z.enum(['pending', 'kept', 'discarded']),
  target: z.string(),
  source: z.enum(['you', 'agent']),
  text: z.string(),
});
export type CandidateStatus = z.infer<typeof EthosCandidateSchema>['status'];
export type CandidateSource = z.infer<typeof EthosCandidateSchema>['source'];
export type EthosCandidate = z.infer<typeof EthosCandidateSchema>;

const ReviewFindingSchema = z.object({
  verdict: z.enum(['clean', 'blocking']),
  finding: z.string().nullable(),
  at: z.string(),
  verified: z.boolean(),
});
export type ReviewVerdict = z.infer<typeof ReviewFindingSchema>['verdict'];
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

const CachedChecksSchema = z.object({
  key: z.string(),
  results: z.array(CheckResultSchema),
});
export type CachedChecks = z.infer<typeof CachedChecksSchema>;

const AporiaSchema = z.object({ reason: z.string(), at: z.string() });
export type Aporia = z.infer<typeof AporiaSchema>;

export const StoredTicketSchema = z.object({
  id: z.string(),
  title: z.string().nullable().default(null),
  branch: z.string().nullable().default(null),
  worktree: z.string().nullable().default(null),
  prUrl: z.string().nullable().default(null),
  specPath: z.string().nullable().default(null),
  planPath: z.string().nullable().default(null),
  port: z.number().nullable().default(null),
  isolationPorts: z.record(z.string(), z.number()).nullable().default(null),
  planCommit: z.string().nullable().default(null),
  created: z.string(),
  updated: z.string(),
  specText: z.string().default(''),
  ethosCandidates: z.array(EthosCandidateSchema).default([]),
  checks: CachedChecksSchema.nullable().default(null),
  reviewFindings: z.array(ReviewFindingSchema).default([]),
  reviewToken: z.string().nullable().default(null),
  // The reviewer roles dispatched for the CURRENT round. A round is done when every one of them is in a
  // terminal state, so "done" cannot be read off the first reviewer alone once a diff earns more than one.
  reviewerRoles: z.array(z.string()).default([]),
  aporia: AporiaSchema.nullable().default(null),
  notified: z.boolean().default(false),
  guardrails: TicketGuardrailsPinSchema.nullable().default(null),
  verification: VerificationSchema.nullable().default(null),
  criteriaSkips: z.array(CriterionSkipSchema).default([]),
});

// The shape on disk. Exactly what we save.
export type StoredTicket = z.infer<typeof StoredTicketSchema>;

// The shape in memory: the saved one plus the stage log, added when we read.
// The log itself lives in its own file, never in the ticket file.
export interface Ticket extends StoredTicket {
  stageLog: StageLogEntry[];
}
