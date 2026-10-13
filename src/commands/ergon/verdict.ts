import fs from 'node:fs';
import { REVIEW_VERDICT, RUN_OUTCOMES, reviewerRoles } from '../../ticket/ticketStore.js';
import { CHECK_VERDICT } from '../../checks.js';
import { runFiles } from '../../ticket/paths.js';
import { logText } from '../../audit/logText.js';
import type { Ticket, ReviewFinding, ReviewVerdict } from '../../types/ticket.js';
import type { BackgroundStatus } from '../../ticket/background.js';

// Turns a check result into the word we save on the ticket.
export const OUTCOME_FOR_VERDICT = Object.freeze({
  [CHECK_VERDICT.PASSED]: RUN_OUTCOMES.OK,
  [CHECK_VERDICT.FAILED]: RUN_OUTCOMES.CHECKS_FAILED,
  [CHECK_VERDICT.UNKNOWN]: RUN_OUTCOMES.CHECKS_UNKNOWN,
});

// A reviewer that can not call the CLI must still end its output with this
// line. Upper or lower case is fine, and the reason is optional.
const VERDICT_LINE_RE = /^VERDICT:\s*(clean|blocking)\b[ \t]*[-—:]?[ \t]*(.*)$/i;

// How many lines of REAL content back from the end we are willing to look. The verdict is meant to
// be the last thing written, and used to have to be exactly the last non-empty line — which meant a
// code fence around it, a `**bold**` wrapper, or one sentence of sign-off after it made a real
// verdict unreadable and the round came back `NONE`. glafka's own prompt used
// to demonstrate the fenced form. Two is deliberate and is as far as this may go. The older
// rule still holds: a `VERDICT:` line sitting ABOVE substantive output — a quoted diff, a first
// draft the reviewer then revised — is not the round's answer and must never be read as one. Two
// lines covers "verdict, then one closing sentence" and nothing more.
const VERDICT_SCAN_LINES = 2;

// A line that is only markdown scaffolding, carrying no claim of its own. It is skipped without being
// counted, so a fenced verdict costs nothing from the budget above — the fence is not content standing between us and the answer.
const SCAFFOLD_RE = /^(?:`{3,}[a-z]*|-{3,}|\*{3,}|_{3,})$/i;

// Strips the markdown a model wraps around a line it was told to emit
// verbatim: a fence, emphasis, a list bullet, a blockquote marker.
function unwrap(line: string): string {
  return line
    .trim()
    .replace(/^[>\-*+]\s+/, '')
    .replace(/^`+|`+$/g, '')
    .replace(/^\*\*|\*\*$/g, '')
    .replace(/^_+|_+$/g, '')
    .trim();
}

// `--output-format json` is the only way to get a token count out of an agent,
// and it wraps the whole reply in one object — so the verdict stops being a
// line at all. Unwrap it first, and everything below applies unchanged, the
// two-line budget included.
function unwrapAgentJson(tail: string): string {
  const trimmed = tail.trim();
  if (!trimmed.startsWith('{')) return tail;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const result = (parsed as { result?: unknown }).result;
    return typeof result === 'string' ? result : tail;
  } catch {
    // Not one object, or the tail cut it in half. Scan what we have.
    return tail;
  }
}

// Walks backwards over the tail, handing back each candidate line already
// unwrapped, and stops after VERDICT_SCAN_LINES lines of real content.
function* tailCandidates(logPath: string): Generator<string> {
  const lines = logText(unwrapAgentJson(readTail(logPath))).split('\n');
  let seen = 0;
  for (let i = lines.length - 1; i >= 0 && seen < VERDICT_SCAN_LINES; i--) {
    const raw = lines[i]!.trim();
    if (raw === '') continue;
    if (SCAFFOLD_RE.test(raw)) continue;
    seen += 1;
    yield unwrap(raw);
  }
}

// The verdict is always the last line, so we only read the end of the file.
// Logs can grow to many megabytes, and we read them on every tick.
const TAIL_BYTES = 64 * 1024;

function readTail(filePath: string): string {
  const fd = fs.openSync(filePath, 'r');
  try {
    const { size } = fs.fstatSync(fd);
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

// Reads the verdict straight from the saved log. No ticket state needed.
export function parseVerdictFromLog(
  logPath: string | null,
): { verdict: ReviewVerdict; finding: string | null } | null {
  if (!logPath || !fs.existsSync(logPath)) return null;

  // The FIRST match walking backwards is the LAST verdict the reviewer wrote.
  for (const candidate of tailCandidates(logPath)) {
    const match = candidate.match(VERDICT_LINE_RE);
    if (!match) continue;
    const finding = match[2]!.trim();
    // The pattern only ever matches "clean" or "blocking",
    // so the lower-case text is always one of the two real values.
    return {
      verdict: match[1]!.toLowerCase() as ReviewVerdict,
      finding: finding === '' ? null : finding,
    };
  }
  return null;
}

// The coder's shell-free way of saying it stopped without finishing. `glafka aporia` is the
// documented way, and it is itself a shell command — so in the one situation that most needs it, an
// agent that cannot run commands, it is unreachable. The reviewer has had a shell-free fallback for
// exactly this reason (the VERDICT line); the coder had none, and a blocked coder exited 0 and read
// as "finished".
const STUCK_LINE_RE = /^STUCK:[ \t]*[-—:]?[ \t]*(.+)$/i;

// Same scan window and same unwrapping as the verdict line, for the same
// reason: a model wraps a line it was told to emit verbatim.
export function parseStuckFromLog(logPath: string | null): string | null {
  if (!logPath || !fs.existsSync(logPath)) return null;
  for (const candidate of tailCandidates(logPath)) {
    const match = candidate.match(STUCK_LINE_RE);
    if (match) return match[1]!.trim();
  }
  return null;
}

// How much of a reviewer's own report we are willing to carry back to the coder. Its final answer is
// the whole log, and a long one would push the plan out of the coder's prompt.
const MAX_REPORT_LINES = 120;

// The reviewer's own words for a round whose verdict arrived through the log line rather than
// through `krisis`. This exists because those two paths are not equally informative and used to be
// treated as if they were. `krisis` writes one finding per call onto the ticket; the log line
// writes nothing, so the fix-list the next coder is handed — built from `ticket.reviewFindings` —
// was empty, and the coder re-read the plan with no idea what the reviewer objected to.
// The verdict was never lost; the reasons were. Deliberately NOT written onto
// the ticket as a `ReviewFinding`. That array is the record of what a reviewer actually called in,
// and `resolveVerdict` reads it to decide whether the verdict came from `krisis`. Adding a
// synthesised entry would make an unverified log line report itself as a real call.
export function blockingReviewerReports({
  stateDir,
  ticket,
}: {
  stateDir: string;
  ticket: Pick<Ticket, 'id' | 'reviewerRoles'>;
}): { role: string; finding: string | null; report: string }[] {
  const out: { role: string; finding: string | null; report: string }[] = [];
  for (const role of reviewerRoles(ticket as Ticket)) {
    const { logPath } = runFiles(stateDir, ticket.id, role);
    const parsed = parseVerdictFromLog(logPath);
    if (parsed?.verdict !== REVIEW_VERDICT.BLOCKING) continue;
    let report = '';
    try {
      // Decoded, not raw: this text is read by a person and pasted to the
      // coder for the fix round.
      report = logText(readTail(logPath)).trim();
    } catch {
      // The verdict is still worth carrying without the body behind it.
    }
    const lines = report.split('\n');
    if (lines.length > MAX_REPORT_LINES) {
      report = `… (${lines.length - MAX_REPORT_LINES} earlier line(s) omitted — the full report is at ${logPath})\n${lines
        .slice(-MAX_REPORT_LINES)
        .join('\n')}`;
    }
    out.push({ role, finding: parsed.finding, report });
  }
  return out;
}

// --------------------------------------------------------------------------- Three ways a verdict can reach us, from most trusted to least.

export const VERDICT_SOURCE = Object.freeze({
  // A real call through the CLI.
  KRISIS: 'krisis',
  // No call, but the output said it in plain text.
  // This is the only way that works when the cage blocks the CLI.
  LOG_LINE: 'log-line',
  // The reviewer finished but said nothing we can read.
  NONE: 'none',
  // The process itself failed. Not the same as "no verdict".
  RUN_FAILED: 'run-failed',
  // Still running, or never started.
  NOT_DONE: 'not-done',
});

export type ResolvedVerdict =
  | { source: 'not-done'; verdict: null }
  | { source: 'krisis'; verdict: ReviewVerdict }
  | { source: 'run-failed'; verdict: null }
  | { source: 'log-line'; verdict: ReviewVerdict; finding: string | null }
  | { source: 'none'; verdict: null };

// Turns all three ways into one answer. `findings` covers this round only. The verdict for a round
// that dispatched MORE THAN ONE reviewer. Three rules, in order: 1. If any reviewer is still going,
// the round has no verdict yet. A "clean" from the one that finished first says nothing about the
// diff the other is still reading. 2. Blocking wins. krisis findings land on one ticket-level array
// whichever reviewer called it, so a single objection blocks the round. 3. A blocking line in any
// reviewer's log wins too, even over a krisis clean. Only then is a clean read, from krisis or the
// logs.
export function resolveRoundVerdict({
  statuses,
  findings,
}: {
  statuses: BackgroundStatus[];
  findings: ReviewFinding[];
}): ResolvedVerdict {
  if (statuses.length === 0) return { source: VERDICT_SOURCE.NOT_DONE, verdict: null };

  // One reviewer is the old behaviour, unchanged — including the deliberate rule that a verdict still
  // counts after a crash, because a real reviewer did run and record it.
  if (statuses.length === 1) return resolveVerdict({ status: statuses[0]!, findings });

  const notDoneStates = new Set(['not-started', 'running', 'stalled', 'timed-out']);
  if (statuses.some((s) => notDoneStates.has(s.state))) {
    return { source: VERDICT_SOURCE.NOT_DONE, verdict: null };
  }

  // Blocking wins, and costs little to trust: krisis findings land on one
  // ticket-level array whichever reviewer called it.
  if (findings.some((f) => f.verdict === REVIEW_VERDICT.BLOCKING)) {
    return { source: VERDICT_SOURCE.KRISIS, verdict: REVIEW_VERDICT.BLOCKING };
  }

  // That same ticket-level array is why clean needs a stricter test here than it does for one
  // reviewer. A "clean" finding carries no record of WHICH reviewer wrote it, so if one reviewer
  // crashed without recording anything, the other's clean would be read as the whole round's — and
  // a missing opinion would pass as agreement. Every reviewer has to have finished before the round
  // can be clean.
  const crashed = statuses.find((s) => s.state !== 'finished');
  if (crashed) return { source: VERDICT_SOURCE.RUN_FAILED, verdict: null };

  // Read EVERY reviewer's log, not just the first one's. Reading statuses[0] alone dropped a
  // second reviewer's blocking line entirely.
  const parsed = statuses.map((s) => parseVerdictFromLog('logPath' in s ? s.logPath : null));
  const blocking = parsed.find((p) => p?.verdict === REVIEW_VERDICT.BLOCKING);
  // Before the krisis clean: one reviewer's clean must not hide another's blocking line.
  if (blocking) {
    return {
      source: VERDICT_SOURCE.LOG_LINE,
      verdict: blocking.verdict,
      finding: blocking.finding,
    };
  }

  // A verified clean through krisis settles it for the round.
  if (findings.some((f) => f.verdict === REVIEW_VERDICT.CLEAN && f.verified)) {
    return { source: VERDICT_SOURCE.KRISIS, verdict: REVIEW_VERDICT.CLEAN };
  }

  // Nobody recorded anything, so fall back to the logs.
  // Clean only if EVERY reviewer said so. A missing line is not agreement —
  // the same rule the "every reviewer must have finished" check above applies.
  if (parsed.length > 0 && parsed.every((p) => p?.verdict === REVIEW_VERDICT.CLEAN)) {
    return {
      source: VERDICT_SOURCE.LOG_LINE,
      verdict: REVIEW_VERDICT.CLEAN,
      finding: parsed[0]!.finding,
    };
  }
  return { source: VERDICT_SOURCE.NONE, verdict: null };
}

export function resolveVerdict({
  status,
  findings,
}: {
  status: BackgroundStatus;
  findings: ReviewFinding[];
}): ResolvedVerdict {
  // Still running or never started, so do not trust any finding yet,
  // not even an early "clean" one.
  const notDoneStates = new Set(['not-started', 'running', 'stalled', 'timed-out']);
  if (notDoneStates.has(status.state)) {
    return { source: VERDICT_SOURCE.NOT_DONE, verdict: null };
  }
  // The process is done, one way or another. A verdict still counts even
  // after a crash, because a real reviewer did run and record it.
  const blocking = findings.some((f) => f.verdict === REVIEW_VERDICT.BLOCKING);
  // A "clean" verdict needs this round's token, or a coder could mark its
  // own work clean. A "blocking" one is always trusted, since it costs little.
  const clean = findings.some((f) => f.verdict === REVIEW_VERDICT.CLEAN && f.verified);
  if (blocking || clean) {
    return {
      source: VERDICT_SOURCE.KRISIS,
      verdict: blocking ? REVIEW_VERDICT.BLOCKING : REVIEW_VERDICT.CLEAN,
    };
  }
  if (status.state !== 'finished') {
    return { source: VERDICT_SOURCE.RUN_FAILED, verdict: null };
  }
  // We test for the field with 'in', because type narrowing is not
  // reliable here with strictNullChecks off.
  const parsed = parseVerdictFromLog('logPath' in status ? status.logPath : null);
  if (parsed)
    return {
      source: VERDICT_SOURCE.LOG_LINE,
      verdict: parsed.verdict,
      finding: parsed.finding,
    };
  return { source: VERDICT_SOURCE.NONE, verdict: null };
}
