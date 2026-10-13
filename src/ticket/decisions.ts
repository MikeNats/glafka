import fs from 'node:fs';
import path from 'node:path';
import { ticketsDir, closedTicketsDir, ticketFiles, decisionsDocPath } from './paths.js';

// What was settled while the ticket ran, and is in neither spec.md nor plan.md.
// A fresh session reads this after the plan, so a cleared session loses nothing.

export const DECISION_SOURCE = Object.freeze({ PERSON: 'person', CODER: 'coder' });
export type DecisionSource = (typeof DECISION_SOURCE)[keyof typeof DECISION_SOURCE];

export const PERSON_HEADING = '## Person decisions';
export const CODER_HEADING = '## Coder decisions';

// The person's section is first, and stays first. Order is the gravity:
// what a person settled is read before what the coder worked out.
function emptyDoc(id: string): string {
  return `# Decisions — ${id}\n\n${PERSON_HEADING}\n\n${CODER_HEADING}\n`;
}

// An open ticket first, then a closed one. A decision can be read after close,
// but it is only ever written while the ticket is open.
function decisionsPath(stateDir: string, id: string): string {
  const active = ticketFiles(ticketsDir(stateDir), id);
  if (fs.existsSync(active.decisionsFile)) return active.decisionsFile;

  const closed = ticketFiles(closedTicketsDir(stateDir), id);
  return fs.existsSync(closed.decisionsFile) ? closed.decisionsFile : active.decisionsFile;
}

export function readDecisions(stateDir: string, id: string): string | null {
  const filePath = decisionsPath(stateDir, id);
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
}

// Copies what was decided into git, where it outlives the state directory.
// Call it at close only, beside publishAudit and for the same reason.
// Returns the file written, or null when the ticket decided nothing.
export function publishDecisions({
  repoRoot,
  stateDir,
  ticketId,
}: {
  repoRoot: string;
  stateDir: string;
  ticketId: string;
}): string | null {
  const from = decisionsPath(stateDir, ticketId);
  if (!fs.existsSync(from)) return null;

  const to = decisionsDocPath(repoRoot, ticketId);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  // Copy, not move, so a throw here can be retried.
  fs.copyFileSync(from, to);
  return to;
}

// Adds one line under the right heading. Returns the file it wrote.
export function appendDecision(
  stateDir: string,
  id: string,
  { source, text }: { source: DecisionSource; text: string },
): string {
  const line = text.trim();
  if (line === '') throw new Error(`glafka: a decision needs some text`);
  if (line.includes('\n')) throw new Error(`glafka: one decision is one line`);

  const filePath = ticketFiles(ticketsDir(stateDir), id).decisionsFile;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : emptyDoc(id);
  const heading = source === DECISION_SOURCE.PERSON ? PERSON_HEADING : CODER_HEADING;
  const at = current.indexOf(heading);
  if (at === -1) throw new Error(`glafka: ${filePath} has no ${heading} heading`);

  // Insert straight after the heading's own block, then re-normalise, so the
  // newest line lands at the end of its own section rather than the file.
  const insertAt = at + heading.length;
  const before = current.slice(0, insertAt);
  const after = current.slice(insertAt);
  const existing = after.split('\n## ')[0] ?? '';
  const rest = after.slice(existing.length);
  const bullets = existing.split('\n').filter((l) => l.startsWith('- '));
  bullets.push(`- ${line}`);

  fs.writeFileSync(filePath, `${before}\n\n${bullets.join('\n')}\n\n${rest.replace(/^\n+/, '')}`);
  return filePath;
}
