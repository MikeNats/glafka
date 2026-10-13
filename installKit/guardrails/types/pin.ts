import { z } from 'zod';

// Every field describes a guardrails policy, so the shape lives here now,
// not with the ticket. Still one copy — src/types/ticket.ts imports it back.
export const TicketGuardrailsPinSchema = z.object({
  level: z.number(),
  name: z.string(),
  hash: z.string(),
  widened: z.array(z.string()),
  pinnedAt: z.string(),
});
export type TicketGuardrailsPin = z.infer<typeof TicketGuardrailsPinSchema>;

// The same shape, without the time stamp.
// The time is added when we save it on a ticket.
export type CurrentPin = Omit<TicketGuardrailsPin, 'pinnedAt'>;
