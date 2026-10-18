import type { z } from 'zod';
import { isSafeName } from './contract';

export type Args = Record<string, unknown>;

// A name goes into glafka's command line. Like Elaia's ticket ids it is letters, digits and
// . _ - only, so `--sweep` can never pass as one.
function named(value: unknown, name: string): string {
  if (typeof value === 'string' && isSafeName(value)) return value;
  throw new Error(`"${name}" must be a plain name: letters, digits and . _ - only.`);
}

export const nameArg = (args: Args, name: string) => named(args[name], name);

// A list of names; a missing list is empty.
export function namesArg(args: Args, name: string): string[] {
  const value = args[name] ?? [];
  if (!Array.isArray(value)) throw new Error(`"${name}" must be a list of plain names.`);
  return value.map((v) => named(v, name));
}

// Text goes on glafka's command line too: a leading - would read as a flag.
export function textArg(args: Args, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`"${name}" must be some text.`);
  if (value.trim().startsWith('-')) throw new Error(`"${name}" must not start with "-".`);
  return value;
}

// A ticket in one of the contract's shapes, with a plain name for its id.
export function ticketArg<T extends { id: string }>(args: Args, name: string, shape: z.ZodType<T>) {
  const parsed = shape.safeParse(args[name]);
  if (!parsed.success) throw new Error(`"${name}" is not in the shape Elaia sends.`);
  named(parsed.data.id, `${name}.id`);
  return parsed.data;
}
