import { z } from 'zod';

// One QA result for one acceptance criterion. Only added, never edited.
const VerifyResultSchema = z.object({
  id: z.string(),
  result: z.enum(['pass', 'fail', 'cannot']),
  evidence: z.string(),
  at: z.string(),
  verified: z.boolean(),
});
export type VerifyResult = z.infer<typeof VerifyResultSchema>;
export type VerifyResultKind = VerifyResult['result'];

// The code: the git tree plus the `git status --porcelain` lines.
const CodeSchema = z.object({ tree: z.string(), dirty: z.array(z.string()) });

// One QA round. `outcome` null means the round is still open.
export const VerificationSchema = z.object({
  token: z.string().nullable(),
  // The code when the round started.
  tree: z.string(),
  dirty: z.array(z.string()),
  // New files glafka's own checks made. Not the coder's change, so left out of `dirty` everywhere.
  checkMade: z.array(z.string()).default([]),
  // The code when the round closed. "Same code" later is measured against this.
  closedCode: CodeSchema.nullable().default(null),
  // When the round opened. Null on a round saved before this field existed.
  openedAt: z.string().nullable().default(null),
  spawned: z.boolean(),
  results: z.array(VerifyResultSchema).default([]),
  outcome: z
    .enum(['passed', 'failed', 'cannot', 'untrusted', 'incomplete'])
    .nullable()
    .default(null),
  detail: z.string().nullable().default(null),
  consumed: z.boolean().default(false),
  // The `at` of the aporia closing this round set. Null when it set none.
  aporiaAt: z.string().nullable().default(null),
});
export type Verification = z.infer<typeof VerificationSchema>;
export type VerifyOutcome = NonNullable<Verification['outcome']>;

// A person chose not to check one criterion. Kept apart, so a new round never wipes it.
export const CriterionSkipSchema = z.object({ id: z.string(), reason: z.string(), at: z.string() });
export type CriterionSkip = z.infer<typeof CriterionSkipSchema>;
