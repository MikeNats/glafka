import { z } from 'zod';

// Shapes a workflow tool's plugin sends and gets, besides the ticket itself.

// What a ticket's own chat is told to plan: the ask, and its epic when it has one.
export const TicketBriefSchema = z.object({
  id: z.string(),
  title: z.string(),
  brief: z.string(),
  epic: z.object({ title: z.string(), file: z.string(), sources: z.array(z.string()) }).nullable(),
});
export type TicketBrief = z.infer<typeof TicketBriefSchema>;

// Which ticket a ticket chat belongs to, and where its worktree is.
export const TicketPlaceSchema = z.object({
  id: z.string(),
  title: z.string(),
  worktree: z.string().nullable(),
  branch: z.string().nullable(),
});
export type TicketPlace = z.infer<typeof TicketPlaceSchema>;

// Setup is led by the tool. An id may not hold ':' (a button's value is "<step>:<choice>").
const SetupId = z.string().regex(/^[\w.-]+$/, 'letters, digits, _ . - only');

// A button on a setup card: `id` goes back to the tool, `label` is shown.
export const SetupChoiceSchema = z.object({ id: SetupId, label: z.string().min(1) });

// What setup does next. ask: one card, its text in Markdown. agent: the main chat runs `prompt`,
// and the step counts as answered when that turn ends. done: set up. stop: nothing more now.
export const SetupStepSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ask'),
    id: SetupId,
    text: z.string().min(1),
    choices: z.array(SetupChoiceSchema).min(1),
  }),
  z.object({ kind: z.literal('agent'), id: SetupId, prompt: z.string().min(1) }),
  z.object({ kind: z.literal('done') }),
  z.object({ kind: z.literal('stop') }),
]);
export type SetupStep = z.infer<typeof SetupStepSchema>;

// A setup call's answer: lines to show first ("Installed."), then the next step.
export const SetupReplySchema = z.object({
  said: z.array(z.string()).default([]),
  step: SetupStepSchema,
});
export type SetupReply = z.infer<typeof SetupReplySchema>;

export const CommandResultSchema = z.object({
  code: z.number(),
  stdout: z.string(),
  stderr: z.string(),
});
export type CommandResult = z.infer<typeof CommandResultSchema>;

// One thing a repo can make run on your computer, and the file it came from.
export const RunnableSchema = z.object({
  // Relative to the project: '.claude/settings.json', say.
  file: z.string(),
  // What it is: 'hook SessionStart', 'MCP server db', 'agents.coder'.
  what: z.string(),
  // The command, URL or value, as written in the file.
  run: z.string(),
});
export type Runnable = z.infer<typeof RunnableSchema>;
