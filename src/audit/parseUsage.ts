import path from 'node:path';

export interface Usage {
  in: number;
  out: number;
  // Input served from, and written to, the prompt cache. Claude counts these
  // apart from input_tokens, so without them most of the input was missing.
  cacheRead: number;
  cacheWrite: number;
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
  if (result) return { ...counts(result), source: result.source };

  // No result line. A block that named itself something else — an assistant
  // message — is one turn of a stream the agent never finished, so it is a
  // fraction of the truth. An untyped block is a single-object output, and
  // that IS the run.
  const last = found[found.length - 1]!;
  const source = last.kind === null ? last.source : `${last.source}-partial`;
  return { ...counts(last), source };
}

function counts(u: Usage): Omit<Usage, 'source'> {
  return { in: u.in, out: u.out, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite };
}

// 0 when missing: an agent that reports no cache field used no cache.
function cacheCount(value: unknown): number {
  return typeof value === 'number' ? value : 0;
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

  const {
    input_tokens: input,
    output_tokens: outputTokens,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
  } = usage as Record<string, unknown>;
  if (typeof input !== 'number' || typeof outputTokens !== 'number') return null;
  return {
    in: input,
    out: outputTokens,
    cacheRead: cacheCount(cacheRead),
    cacheWrite: cacheCount(cacheWrite),
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
