import { z } from 'zod';

// A plugin is an MCP server (stdio). Each call below is one of its tools: Elaia calls it with
// { project, args } and reads { result } from its structured content.
export const CONTRACT = 3;

export const CALLS = [
  'describe',
  'detect',
  'tickets',
  'ticket',
  'tokens',
  'runs',
  'create',
  'next',
  'start-work',
  'start-build',
  'close',
  'cancel',
  'base-branch',
  'agent-command',
  'cannot-run-alone',
  'setup-next',
  'setup-answer',
  'plan-prompt',
  'ticket-rules',
  'push-prompt',
  'trust-items',
] as const;
export type CallName = (typeof CALLS)[number];

// What every tool gets: the project folder (empty for describe) and the call's own arguments.
export const ToolInputSchema = z.object({
  project: z.string(),
  args: z.record(z.string(), z.unknown()).default({}),
});
