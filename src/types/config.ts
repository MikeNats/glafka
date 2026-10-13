import { z } from 'zod';

// The project's config file. People edit it by hand, so we check it.
// Strict: a misspelled key like "checkCmd" is refused, not silently dropped.
export const ConfigSchema = z
  .strictObject({
    // Null, not "main", so we can tell "not set" from a real choice.
    baseRef: z.string().nullable(),
    checksCmd: z.string().nullable(),
    e2eCmd: z.string().nullable(),
    portRange: z.strictObject({
      start: z.number().int().positive(),
      end: z.number().int().positive(),
    }),
    // Kills a stuck agent, instead of paying for it for hours.
    ergonTimeoutMs: z.number().int().positive(),
    checksTimeoutMs: z.number().int().positive(),
    e2eTimeoutMs: z.number().int().positive(),
    // Installing packages is slow, so it gets its own time limit.
    bootstrapTimeoutMs: z.number().int().positive(),
    // Time limit for setup and teardown. Without it, a stuck one
    // could hang a command forever.
    isolationHookTimeoutMs: z.number().int().positive(),
    // One shell command per agent role. Empty by default.
    agents: z.record(z.string(), z.string().min(1)),
    // How many times we restart the coder after a bad review,
    // before asking you. This is a starting guess.
    maxReviewRounds: z.number().int().positive(),
    // A shell command run on two events only: ready, or needs you.
    // Null means we stay quiet.
    notifyCmd: z.string().nullable(),
    // This project's own code-review document, if it has one, handed to the reviewer alongside
    // glafka's lanes. Named rather than guessed: a fixed filename would have picked up any
    // CODE_REVIEW.md in the repo — one written for people, or another team's — and fed it to an
    // agent as binding input. Naming it is the project saying "yes, this one".
    reviewDoc: z.string().nullable(),
    // Recording what each agent run cost. Independent of guardrails: this
    // works at level 0, where no hook is installed at all.
    observability: z.strictObject({ enabled: z.boolean() }),
  })
  .superRefine((config, ctx) => {
    if (config.portRange.end < config.portRange.start) {
      ctx.addIssue({
        code: 'custom',
        path: ['portRange', 'end'],
        message:
          `"portRange.end" (${config.portRange.end}) is before ` +
          `"portRange.start" (${config.portRange.start})`,
      });
    }
  });
export type Config = z.infer<typeof ConfigSchema>;
