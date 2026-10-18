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

// One line of the setup card.
export const SetupItemSchema = z.object({
  key: z.string(),
  label: z.string(),
  done: z.boolean(),
  optional: z.boolean(),
});
export type SetupItem = z.infer<typeof SetupItemSchema>;

// Something setup found for you to keep or change, shown as one card. `keep` labels the button.
export const SetupFindingSchema = z.object({
  key: z.string(),
  title: z.string(),
  items: z.array(z.string()),
  keep: z.string(),
});
export type SetupFinding = z.infer<typeof SetupFindingSchema>;

// A setup step the tool does with no agent. `label` is said before, `done` after.
export const SetupStepSchema = z.object({ key: z.string(), label: z.string(), done: z.string() });

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
