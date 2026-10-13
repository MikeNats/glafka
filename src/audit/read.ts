import fs from 'node:fs';
import { readRunRecords, type RunRecord } from './record.js';
import { readStageLogFor } from '../ticket/ticketStore.js';
import { readGuardrailsLog, resolvePolicy } from '../../installKit/guardrails/index.js';
import { TICKET_ID_RE } from '../ticket/ids.js';
import { ticketsDir, closedTicketsDir, ticketFiles } from '../ticket/paths.js';

export interface AuditEvent {
  at: string;
  kind: 'run' | 'stage' | 'tool';
  [key: string]: unknown;
}

export interface AuditReport {
  // 2: totals became nullable and gained the runsWith* counts. A reader
  // written against 1 would plot an unmeasured total as zero.
  schema: 2;
  ticket: string | null;
  sources: { runs: boolean; stages: boolean; tools: boolean };
  // The guardrails log rolls at 8MB. When it has, its oldest calls are gone.
  toolsPartial: boolean;
  events: AuditEvent[];
  totals: {
    runs: number;
    durationMs: number | null;
    runsWithDuration: number;
    // Null when NOT ONE run had its tokens measured. Summing those as 0
    // would report an unmeasured ticket as a free one.
    tokensIn: number | null;
    tokensOut: number | null;
    // How many of `runs` contributed a token count, so a partial total
    // cannot pass itself off as a complete one.
    runsWithTokens: number;
    // Null when guardrails was not watching. "0 denied" there reads as
    // "nothing was blocked", when the truth is that nobody was looking.
    denied: number | null;
  };
}

// Merges the three logs by time. Nothing is copied — the join happens here,
// so guardrails' own file is only ever read.
export function readAudit({
  stateDir,
  repoRoot,
  ticketId,
}: {
  stateDir: string;
  repoRoot: string;
  ticketId: string | null;
}): AuditReport {
  const runs = readRunRecords(stateDir, ticketId);
  const stages = ticketId === null ? [] : readStageLogFor(stateDir, ticketId);

  const { policy } = resolvePolicy({ repoRoot });
  const tools = policy.audit.enabled ? readGuardrailsLog(policy, { stateDir, ticketId }) : [];
  // Both tokens, the same way guardrails' own expand() does it. Replacing
  // only $stateDir would test a path that never exists, so it never warned.
  const toolLogPath = policy.audit.path
    .replace('$stateDir', stateDir)
    .replace('$ticketId', ticketId ?? 'no-ticket');
  const toolsPartial = policy.audit.enabled && fs.existsSync(`${toolLogPath}.1`);

  const events: AuditEvent[] = [
    ...runs.map((r) => ({ ...r }) as AuditEvent),
    ...stages.map((s) => ({ ...s, kind: 'stage' }) as AuditEvent),
    ...tools.map((t) => ({ ...t, kind: 'tool' }) as AuditEvent),
  ].sort((a, b) => a.at.localeCompare(b.at));

  return {
    schema: 2,
    ticket: ticketId,
    sources: { runs: runs.length > 0, stages: stages.length > 0, tools: policy.audit.enabled },
    toolsPartial,
    events,
    // Null, not 0, when the tool log was never written.
    totals: totalsOf(runs, policy.audit.enabled ? tools.filter((t) => !t.allow).length : null),
  };
}

// Null tokens are unmeasured, so they add nothing. They must never be
// counted as a measured zero.
function totalsOf(runs: RunRecord[], denied: number | null): AuditReport['totals'] {
  const measured = runs.filter((r) => r.tokens !== null);
  const timed = runs.filter((r) => r.durationMs !== null);
  return {
    runs: runs.length,
    durationMs: timed.length === 0 ? null : timed.reduce((sum, r) => sum + r.durationMs!, 0),
    runsWithDuration: timed.length,
    // Null, not 0, when nothing was measured — the same rule the per-run
    // records follow.
    tokensIn: measured.length === 0 ? null : measured.reduce((sum, r) => sum + r.tokens!.in, 0),
    tokensOut: measured.length === 0 ? null : measured.reduce((sum, r) => sum + r.tokens!.out, 0),
    runsWithTokens: measured.length,
    denied,
  };
}

export interface AuditSummaryRow {
  ticket: string;
  runs: number;
  durationMs: number | null;
  runsWithDuration: number;
  tokensIn: number | null;
  tokensOut: number | null;
  runsWithTokens: number;
  denied: number | null;
}

export interface AuditSummary {
  schema: 2;
  tickets: AuditSummaryRow[];
  byRole: {
    role: string;
    runs: number;
    durationMs: number | null;
    runsWithDuration: number;
    // Same rule as a ticket's totals: null when no run of this role had
    // its tokens measured.
    tokensIn: number | null;
    tokensOut: number | null;
    runsWithTokens: number;
  }[];
}

// What a repo-level run is filed under: a scan or a report belongs to no
// ticket. Same word guardrails uses for the same case.
export const NO_TICKET = 'no-ticket';

// Every ticket that has a record, open or closed, plus the repo-level runs.
// Seven runs on one ticket is the waste signal, and it only shows up side by side.
export function readAuditSummary({
  stateDir,
  repoRoot,
}: {
  stateDir: string;
  repoRoot: string;
}): AuditSummary {
  const tickets: AuditSummaryRow[] = [];
  const roles = new Map<
    string,
    { runs: number; durationMs: number; timed: number; in: number; out: number; measured: number }
  >();

  // null is the repo-level record — scans, reports, compaction passes. It is
  // real spend, and without it here nothing could ever read it back.
  for (const id of [...ticketsWithRecords(stateDir), null]) {
    const report = readAudit({ stateDir, repoRoot, ticketId: id });
    if (report.totals.runs === 0) continue;
    tickets.push({ ticket: id ?? NO_TICKET, ...report.totals });

    for (const event of report.events) {
      if (event.kind !== 'run') continue;
      const role = String(event.role);
      const sum = roles.get(role) ?? {
        runs: 0,
        durationMs: 0,
        timed: 0,
        in: 0,
        out: 0,
        measured: 0,
      };
      const used = event.tokens as { in: number; out: number } | null;
      sum.runs += 1;
      // Same rule as the tokens below: an unmeasured run adds nothing and
      // is counted, so a partial total cannot read as a complete one.
      if (event.durationMs !== null) {
        sum.durationMs += event.durationMs as number;
        sum.timed += 1;
      }
      // Only measured runs move the token sum, and we count them so a
      // partial total cannot read as a complete one.
      if (used !== null) {
        sum.in += used.in;
        sum.out += used.out;
        sum.measured += 1;
      }
      roles.set(role, sum);
    }
  }

  return {
    schema: 2,
    tickets: tickets.sort((a, b) => a.ticket.localeCompare(b.ticket)),
    byRole: [...roles.entries()]
      .map(([role, s]) => ({
        role,
        runs: s.runs,
        durationMs: s.timed === 0 ? null : s.durationMs,
        runsWithDuration: s.timed,
        tokensIn: s.measured === 0 ? null : s.in,
        tokensOut: s.measured === 0 ? null : s.out,
        runsWithTokens: s.measured,
      }))
      // Unmeasured sorts last: it is not the smallest, it is unknown.
      .sort((a, b) => (b.durationMs ?? -1) - (a.durationMs ?? -1)),
  };
}

// Read off disk, not off a ticket list: a closed ticket still has a record.
// A bad filename is skipped, not passed on — readAudit throws on that shape.
function ticketsWithRecords(stateDir: string): string[] {
  const found = new Set<string>();
  for (const dir of [ticketsDir(stateDir), closedTicketsDir(stateDir)]) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      // By id validity, then by the record inside the folder. Scanning for a
      // `<id>.record.jsonl` suffix finds nothing under the folder layout, and
      // an empty audit reads as "no runs" rather than as a broken scan.
      if (!TICKET_ID_RE.test(name)) continue;
      if (fs.existsSync(ticketFiles(dir, name).recordFile)) found.add(name);
    }
  }
  return [...found];
}
