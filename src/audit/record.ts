import fs from 'node:fs';
import path from 'node:path';
import { ticketsDir, closedTicketsDir, ticketFiles } from '../ticket/paths.js';
import type { Role } from '../types/ticket.js';

// Which command spawned the run. NOT the ticket's Stage: these are commands
// (odysse, logos), and a ticket stage is a different vocabulary.
export const AUDIT_STAGES = Object.freeze({
  GENESIS: 'genesis',
  ERGON: 'ergon',
  REVIEW: 'review',
  // The QA tester checking the acceptance criteria (epalitheusis).
  VERIFY: 'verify',
  EPISTLE: 'epistle',
  ODYSSE: 'odysse',
  HEUREKA: 'heureka',
  LOGOS: 'logos',
  // A prompt handed to an agent by a caller that named no stage of its own.
  DELIVER: 'deliver',
});
export type AuditStage = (typeof AUDIT_STAGES)[keyof typeof AUDIT_STAGES];

// One JSON line per agent run. Small on purpose: this file outlives the
// ticket, unlike the prompt and log under runs/.
export interface RunRecord {
  at: string;
  kind: 'run';
  stage: AuditStage;
  role: Role;
  agent: string;
  // Null when we could not tell. A run whose start we never read is not a
  // run that took no time, and a prompt we cannot size is not an empty one.
  durationMs: number | null;
  exitCode: number | null;
  promptBytes: number | null;
  // Null when glafka could not see the agent's output. Never zero.
  responseBytes: number | null;
  tokens: { in: number; out: number } | null;
  tokenSource: string | null;
  // What this run was, when the stage alone cannot say. Two `genesis` rows on
  // one ticket are the spec and the plan, and nothing else distinguishes them.
  // Null on every row that needs no such word — most of them.
  note?: string | null;
}

// A run with no ticket — a scan, a report — still costs money. Same
// "no-ticket" name guardrails already uses for the same case.
export function recordPath(stateDir: string, ticketId: string | null): string {
  if (ticketId === null) return path.join(stateDir, 'records', 'no-ticket.record.jsonl');

  const active = ticketFiles(ticketsDir(stateDir), ticketId);
  if (fs.existsSync(active.recordFile)) return active.recordFile;

  const closed = ticketFiles(closedTicketsDir(stateDir), ticketId);
  return fs.existsSync(closed.recordFile) ? closed.recordFile : active.recordFile;
}

// Never throws. A run must not fail because a log line could not be written.
export function appendRunRecord(
  stateDir: string,
  ticketId: string | null,
  record: RunRecord,
): void {
  try {
    const filePath = recordPath(stateDir, ticketId);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`);
  } catch {
    // Deliberately silent. Losing one line is not worth failing a ticket over.
  }
}

// Parseable JSON is not the same as a record. A truncated write or a hand
// edit leaves a line that parses but has no `at`, and sorting on it throws.
function isRunRecord(value: unknown): value is RunRecord {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<RunRecord>;
  return (
    row.kind === 'run' &&
    typeof row.at === 'string' &&
    !Number.isNaN(Date.parse(row.at)) &&
    (row.durationMs === null || typeof row.durationMs === 'number')
  );
}

// Broken lines are skipped, the way guardrails reads its own log.
export function readRunRecords(stateDir: string, ticketId: string | null): RunRecord[] {
  const filePath = recordPath(stateDir, ticketId);
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line): RunRecord[] => {
      try {
        const parsed: unknown = JSON.parse(line);
        return isRunRecord(parsed) ? [parsed] : [];
      } catch {
        return [];
      }
    });
}
