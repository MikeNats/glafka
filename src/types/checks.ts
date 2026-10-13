import { z } from 'zod';

// Written out by hand, so this file imports nothing.
// Keep it in step with the list in src/checks.ts.
export type ChecksVerdict = 'passed' | 'failed' | 'unknown';

// The result of one named check. We check its shape, because it is also
// saved inside a ticket file on disk.
export const CheckResultSchema = z.object({
  name: z.string(),
  passed: z.boolean(),
  output: z.string(),
  // Set only when the output was cut off,
  // so we never saw whether it really passed.
  unknown: z.boolean().optional(),
});
export type CheckResult = z.infer<typeof CheckResultSchema>;
