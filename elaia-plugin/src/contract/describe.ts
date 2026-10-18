import { z } from 'zod';

// What a plugin says about itself, once: names, folders, rules. Paths are relative to a project.
export const DescribeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  // Where the tool writes when a ticket moves, so Elaia can watch it; null to rely on the timer.
  watch: z.object({ dir: z.string(), files: z.string() }).nullable(),
  worktreesDir: z.string(),
  docsDir: z.string(),
  // No chat may edit these. The second list is locked in ticket and epic chats only.
  lockedFiles: z.array(z.string()),
  lockedOutsideMain: z.array(z.string()),
  // The tool's own commands the chats may run without asking (Claude permission rules).
  allowedTools: z.array(z.string()),
  // Commands to block (Claude permission rules). In otherTicket, {id} stands for another ticket.
  blocked: z.object({
    planning: z.array(z.string()),
    creating: z.array(z.string()),
    shared: z.array(z.string()),
    pushing: z.array(z.string()),
    otherTicket: z.array(z.string()),
  }),
  // Told to every chat, and to the main chat about one ticket or many.
  chatRules: z.string(),
  newTicketRules: z.string(),
  // Where the planning chat writes a ticket's plan; {id} stands for the ticket.
  planFile: z.string(),
});
export type PluginInfo = z.infer<typeof DescribeSchema>;
