import type { AuditReport, AuditEvent, AuditSummary } from './read.js';
import type { RunRecord } from './record.js';

function hhmmss(at: string): string {
  return at.slice(11, 19);
}

function duration(ms: number | null): string {
  if (ms === null) return '—';
  const total = Math.round(ms / 1000);
  return total < 60
    ? `${total}s`
    : `${Math.floor(total / 60)}m${String(total % 60).padStart(2, '0')}s`;
}

// 48000 -> "48.0k". Null is unmeasured and says so.
function tokens(count: number | null): string {
  if (count === null) return '—';
  return count < 1000 ? String(count) : `${(count / 1000).toFixed(1)}k`;
}

// What the tool call was ON. A denied call that does not say what was denied
// answers none of the questions this log exists for.
const TOOL_DETAIL_WIDTH = 34;

function what(event: AuditEvent): string {
  const action = (event.action ?? {}) as Record<string, unknown>;
  const detail = action.command ?? action.path ?? action.url ?? '';
  const text = typeof detail === 'string' ? detail.replace(/\s+/g, ' ').trim() : '';
  return text.length > TOOL_DETAIL_WIDTH ? `${text.slice(0, TOOL_DETAIL_WIDTH - 1)}…` : text;
}

// "20.5k cache read · 4.6k cache write". Null reads as unmeasured, like tokens().
function cache(read: number | null, write: number | null): string {
  return `${tokens(read)} cache read · ${tokens(write)} cache write`;
}

function line(event: AuditEvent): string {
  const at = hhmmss(event.at);
  if (event.kind === 'stage') return `${at}   stage   ${String(event.stage)}`;
  if (event.kind === 'tool') {
    const verdict = event.allow ? 'allow' : 'DENY';
    return `${at}     tool  ${String(event.op).padEnd(8)} ${what(event).padEnd(34)}${verdict}`;
  }
  const used = event.tokens as RunRecord['tokens'];
  const counts = used === null ? 'tokens not measured' : `${tokens(used.in)}→${tokens(used.out)}`;
  // A row saved before cache was counted has no cache fields, so it says nothing.
  const cached =
    used !== null && (used.cacheRead !== undefined || used.cacheWrite !== undefined)
      ? `   ${cache(used.cacheRead ?? 0, used.cacheWrite ?? 0)}`
      : '';
  // Killed by a signal, not run to completion — never render that as "null".
  const exitCode = event.exitCode as number | null;
  return (
    `${at}   run     ${String(event.stage).padEnd(9)}${String(event.role).padEnd(9)}` +
    `${String(event.agent).padEnd(9)}${duration(event.durationMs as number).padStart(7)}   ` +
    `${counts.padEnd(20)}exit ${exitCode === null ? '—' : exitCode}${cached}`
  );
}

// Null in, em-dash out. Two nulls are not zero, and adding them is not zero
// either — so the sum is only formed when something was actually measured.
function totalTokens(inTokens: number | null, outTokens: number | null): string {
  if (inTokens === null || outTokens === null) return tokens(null);
  return tokens(inTokens + outTokens);
}

// Rendered from the same object --json prints, so the two cannot drift.
export function renderAudit(report: AuditReport): string {
  if (report.events.length === 0) return `${report.ticket ?? 'no-ticket'}: nothing recorded yet`;

  const { totals } = report;
  const head =
    `${report.ticket ?? 'no-ticket'}   ${totals.runs} run(s) · ` +
    `${duration(totals.durationMs)} · ${totalTokens(totals.tokensIn, totals.tokensOut)} tokens · ` +
    `${cache(totals.tokensCacheRead, totals.tokensCacheWrite)} · ` +
    `${totals.denied === null ? tokens(null) : totals.denied} denied`;

  const notes: string[] = [];
  if (totals.runsWithTokens > 0 && totals.runsWithTokens < totals.runs) {
    notes.push(
      `tokens cover ${totals.runsWithTokens} of ${totals.runs} run(s) — the rest were not measured`,
    );
  }
  if (!report.sources.tools) {
    notes.push('tool log unavailable — guardrails was off, so we do not know what tools ran');
  }
  if (report.toolsPartial) {
    notes.push('tool log has rolled — its oldest entries are gone');
  }

  return [head, '', ...report.events.map(line), ...(notes.length ? ['', ...notes] : [])].join('\n');
}

// Same duration() and tokens() as renderAudit, so the two tables read alike.
export function renderSummary(summary: AuditSummary): string {
  if (summary.tickets.length === 0) return 'nothing recorded yet';

  // Widen to the longest id. A fixed pad let one long ticket name shear
  // every column to its right out of alignment.
  const width = Math.max(6, ...summary.tickets.map((t) => t.ticket.length));
  const rows = summary.tickets.map(
    (t) =>
      `${t.ticket.padEnd(width)}${String(t.runs).padStart(5)}${duration(t.durationMs).padStart(9)}` +
      `${totalTokens(t.tokensIn, t.tokensOut).padStart(9)}` +
      `${tokens(t.tokensCacheRead).padStart(13)}${tokens(t.tokensCacheWrite).padStart(13)}` +
      `${(t.denied === null ? tokens(null) : String(t.denied)).padStart(9)}`,
  );
  const byRole = summary.byRole.map(
    (r) =>
      `${r.role.padEnd(12)}${String(r.runs).padStart(5)}${duration(r.durationMs).padStart(9)}` +
      `${totalTokens(r.tokensIn, r.tokensOut).padStart(9)}` +
      `${tokens(r.tokensCacheRead).padStart(13)}${tokens(r.tokensCacheWrite).padStart(13)}`,
  );

  return [
    `${'ticket'.padEnd(width)}${'runs'.padStart(5)}${'time'.padStart(9)}${'tokens'.padStart(9)}` +
      `${'cache read'.padStart(13)}${'cache write'.padStart(13)}${'denied'.padStart(9)}`,
    ...rows,
    '',
    `${'by role'.padEnd(12)}${'runs'.padStart(5)}${'time'.padStart(9)}${'tokens'.padStart(9)}` +
      `${'cache read'.padStart(13)}${'cache write'.padStart(13)}`,
    ...byRole,
  ].join('\n');
}
