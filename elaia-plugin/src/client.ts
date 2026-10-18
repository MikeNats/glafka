import type { z } from 'zod';
import type { TokenRow } from './contract';
import { runGlafka, type RunResult } from './run';
import {
  AuditSummarySchema,
  CreateJsonSchema,
  PoreiaJsonSchema,
  VimaJsonSchema,
  type GlafkaTicket,
} from './schemas';
import { toNextEvent } from './next';

const tail = (text: string) => text.trim().slice(-400);

// vima runs the checks and e2e before it starts a reviewer; glafka gives each 10 minutes.
const NO_TIME_LIMIT = 0;

function parse<T>(what: string, result: RunResult, schema: z.ZodType<T>): T {
  if (!result.stdout.trim()) {
    throw new Error(
      `glafka ${what} failed (exit ${result.code}): ${tail(result.stderr) || 'no output'}`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    throw new Error(`glafka ${what} did not print JSON. Update glafka to a version with --json.`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `glafka ${what} printed JSON Elaia cannot read. Update glafka. ${parsed.error.message.slice(0, 300)}`,
    );
  }
  return parsed.data;
}

// Read-only calls only, plus the few commands you start on purpose. Never `ergon --status`:
// it records stages and stops runs, so polling it would change your tickets.
export function glafkaClient(bin: string) {
  const call = async <T>(
    cwd: string,
    args: string[],
    schema: z.ZodType<T>,
    timeoutMs?: number,
  ): Promise<T> =>
    parse(args.slice(0, 2).join(' '), await runGlafka(bin, args, cwd, timeoutMs), schema);

  return {
    // glafka's own ticket JSON; handlers.ts turns it into Elaia's shape.
    tickets: async (cwd: string): Promise<GlafkaTicket[]> =>
      (await call(cwd, ['poreia', '--all', '--json'], PoreiaJsonSchema)).tickets,
    // An id glafka does not know, or that is not in glafka's id form, is no ticket: null.
    ticket: async (cwd: string, id: string): Promise<GlafkaTicket | null> => {
      const result = await runGlafka(bin, ['poreia', id, '--json'], cwd);
      const unknown = [`no ticket "${id}"`, `invalid ticket id: "${id}"`];
      if (result.code !== 0 && unknown.some((words) => result.stderr.includes(words))) return null;
      return parse('poreia', result, PoreiaJsonSchema).tickets[0] ?? null;
    },
    advance: async (cwd: string, id: string) =>
      (await call(cwd, ['vima', id, '--json'], VimaJsonSchema, NO_TIME_LIMIT)).results.map(
        toNextEvent,
      ),
    create: async (cwd: string, idea: string): Promise<string> =>
      (await call(cwd, ['create', idea, '--json'], CreateJsonSchema)).id,
    tokens: async (cwd: string): Promise<TokenRow[]> =>
      (await call(cwd, ['audit', '--json'], AuditSummarySchema)).tickets,
  };
}

export type Glafka = ReturnType<typeof glafkaClient>;
