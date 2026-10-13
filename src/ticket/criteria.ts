// Reads the "## Acceptance criteria" section of a spec.
// One criterion per line: "- AC-<n>: <start state> → <action> → <what you see>".
import { fencedLines } from './codeFences.js';

export interface Criterion {
  id: string;
  text: string;
}

export interface ParsedCriteria {
  criteria: Criterion[];
  badLines: string[];
  duplicates: string[];
}

// Level 2 or 3, any case. Allows "4." in front, and "(AC)" or ":" after.
const SECTION_RE = /^(#{2,3})\s+(?:\d+\.\s*)?Acceptance criteria\s*(?:\(AC\))?\s*:?$/i;
const LINE_RE = /^- (AC-\d+):\s*(.+)$/;
const ANY_AC_RE = /^- AC-\d+:/;
const HEADING_RE = /^(#{1,6})\s/;

// The section's heading line, and the first line after the section. Null when there is none.
function findSection(lines: string[], fenced: boolean[]): { start: number; end: number } | null {
  const start = lines.findIndex((line, i) => !fenced[i] && SECTION_RE.test(line.trim()));
  if (start === -1) return null;
  const level = SECTION_RE.exec(lines[start]!.trim())![1]!.length;
  let end = start + 1;
  // A heading at the section's level or above ends it. Code in a fence ends nothing.
  for (; end < lines.length; end++) {
    const heading = fenced[end] ? null : HEADING_RE.exec(lines[end]!.trim());
    if (heading && heading[1]!.length <= level) break;
  }
  return { start, end };
}

export function parseCriteria(spec: string): ParsedCriteria {
  const lines = spec.split('\n');
  const fenced = fencedLines(lines);
  const section = findSection(lines, fenced);
  if (!section) return { criteria: [], badLines: [], duplicates: [] };

  const criteria: Criterion[] = [];
  const badLines: string[] = [];
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (let i = section.start + 1; i < section.end; i++) {
    // Code in a fence is an example, not a criterion.
    if (fenced[i]) continue;
    const line = lines[i]!.trim();
    if (line === '') continue;
    const match = LINE_RE.exec(line);
    const id = match?.[1];
    const text = match?.[2];
    if (!id || !text) {
      badLines.push(line);
      continue;
    }
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
    criteria.push({ id, text: text.trim() });
  }
  return { criteria, badLines, duplicates: [...duplicates] };
}

// True when the spec has an AC heading glafka reads, even an empty one.
export function hasCriteriaSection(spec: string): boolean {
  const lines = spec.split('\n');
  return findSection(lines, fencedLines(lines)) !== null;
}

// Every "- AC-<n>:" line outside the section parseCriteria reads. spec warns about each.
export function strayCriteria(spec: string): string[] {
  const lines = spec.split('\n');
  const fenced = fencedLines(lines);
  const section = findSection(lines, fenced);
  const inSection = (i: number): boolean =>
    section !== null && i > section.start && i < section.end;
  return lines
    .map((raw) => raw.trim())
    .filter((line, i) => !fenced[i] && !inSection(i) && ANY_AC_RE.test(line));
}

// Results are recorded per AC id, so one id twice could never be read back.
export function assertNoDuplicateCriteria(content: string, where: string): void {
  const { duplicates } = parseCriteria(content);
  if (duplicates.length === 0) return;
  throw new Error(
    `${duplicates.join(', ')} appears twice in ${where} — results are recorded per id, ` +
      `so each acceptance criterion needs its own`,
  );
}
