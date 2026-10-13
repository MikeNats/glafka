import path from 'node:path';

export interface Usage {
  in: number;
  out: number;
  source: string;
}

// Agents print prose around their JSON, and stream-json prints one object per
// line — each carrying its OWN incremental usage. Only the result line totals
// the run, so it wins; anything else is a fallback for a run that died first.
export function parseUsage(output: string | null): Usage | null {
  if (!output) return null;
  const found = output
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map(usageOf)
    .filter((u): u is Usage & { kind: string | null } => u !== null);
  if (found.length === 0) return null;

  const result = found.find((u) => u.kind === 'result');
  if (result) return { in: result.in, out: result.out, source: result.source };

  // No result line. A block that named itself something else — an assistant
  // message — is one turn of a stream the agent never finished, so it is a
  // fraction of the truth. An untyped block is a single-object output, and
  // that IS the run.
  const last = found[found.length - 1]!;
  const source = last.kind === null ? last.source : `${last.source}-partial`;
  return { in: last.in, out: last.out, source };
}

// One line, or null. Anything unreadable is null rather than a guess: a wrong
// token count is worse than a missing one.
function usageOf(line: string): (Usage & { kind: string | null }) | null {
  const start = line.indexOf('{');
  const end = line.lastIndexOf('}');
  if (start === -1 || end < start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(line.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const usage = (parsed as { usage?: unknown }).usage;
  if (!usage || typeof usage !== 'object') return null;

  const { input_tokens: input, output_tokens: outputTokens } = usage as Record<string, unknown>;
  if (typeof input !== 'number' || typeof outputTokens !== 'number') return null;
  return {
    in: input,
    out: outputTokens,
    source: 'claude-json',
    kind:
      typeof (parsed as { type?: unknown }).type === 'string'
        ? (parsed as { type: string }).type
        : null,
  };
}

// The prompt was handed to the session you are sitting in. No separate
// process ran, so there is no program name and nothing to measure.
export const SESSION_AGENT = 'session';

// The program's own name, never the flags. "unknown" when there is nothing,
// so the field is always a string a reader can group by.
export function agentName(agentCmd: string): string {
  const first = agentCmd.trim().split(/\s+/)[0];
  return first ? path.basename(first) : 'unknown';
}
