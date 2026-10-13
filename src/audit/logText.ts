// A stream-json log is one JSON object per line, and the agent's words sit
// INSIDE those objects. Everything that reads a log for what it said — the
// verdict line, a blocking report you have to read — goes through here first.

interface TextBlock {
  type: string;
  text?: unknown;
}

// The words a single log line carries. Null means the line is machinery with
// nothing to say (a tool call, a system event) and is dropped.
function lineText(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return line;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Not one object: a plain line that happens to start with a brace, or the
    // tail cut this one in half. Either way it stays as it is.
    return line;
  }
  if (!parsed || typeof parsed !== 'object') return line;
  const event = parsed as { type?: unknown; result?: unknown; message?: { content?: unknown } };

  // The last event of a run, holding the whole final answer.
  if (typeof event.result === 'string') return event.result;

  const content = event.message?.content;
  if (Array.isArray(content)) {
    const said = (content as TextBlock[])
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join('\n');
    return said === '' ? null : said;
  }

  // A typed event we have no words for. Dropping it keeps it from filling the
  // small window the verdict scan looks back over.
  return typeof event.type === 'string' ? null : line;
}

// A log tail as prose. A plain-text log comes back unchanged.
export function logText(tail: string): string {
  return tail
    .split('\n')
    .map(lineText)
    .filter((line): line is string => line !== null)
    .join('\n');
}
