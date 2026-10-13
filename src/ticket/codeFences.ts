// Markdown code fences, read the CommonMark way. Code in a fence is an example, not a spec line.

// A run of 3 or more backticks or tildes, then the rest of the line.
const FENCE_RE = /^(`{3,}|~{3,})(.*)$/;

interface Fence {
  char: string;
  length: number;
}

// CommonMark: the text after a ``` run may not hold a backtick, or it is inline code.
function opensFence(line: string): Fence | null {
  const match = FENCE_RE.exec(line);
  if (!match) return null;
  const run = match[1]!;
  if (run[0] === '`' && match[2]!.includes('`')) return null;
  return { char: run[0]!, length: run.length };
}

// The same character, a run at least as long, and nothing after it.
function closesFence(line: string, open: Fence): boolean {
  const match = FENCE_RE.exec(line);
  if (!match) return false;
  const run = match[1]!;
  return run[0] === open.char && run.length >= open.length && match[2]!.trim() === '';
}

// True for each line inside a code fence, the fence lines too.
export function fencedLines(lines: string[]): boolean[] {
  let open: Fence | null = null;
  return lines.map((raw) => {
    const line = raw.trim();
    if (open) {
      if (closesFence(line, open)) open = null;
      return true;
    }
    open = opensFence(line);
    return open !== null;
  });
}
