import fs from 'node:fs';
import { appendRunRecord, AUDIT_STAGES, type AuditStage, type RunRecord } from './record.js';
import { ROLES, type Role } from '../types/ticket.js';
import { parseUsage, agentName, SESSION_AGENT, type Usage } from './parseUsage.js';
import { logTail } from './logTail.js';
import { runFiles } from '../ticket/paths.js';

export interface RunHandle {
  finish(result: { exitCode: number | null; output: string | null }): void;
}

// What a run row saves of the usage. Null when nothing was measured.
function tokensOf(usage: Usage | null): RunRecord['tokens'] {
  if (!usage) return null;
  return { in: usage.in, out: usage.out, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite };
}

// Nothing to write to, or switched off. A handle that does nothing keeps
// every call site free of an if.
const NOOP: RunHandle = { finish() {} };

// Starts the clock. The caller calls finish() once, whatever the outcome.
export function startRun({
  stateDir,
  ticketId,
  stage,
  role,
  agentCmd,
  promptBytes,
  enabled,
}: {
  stateDir: string | null;
  ticketId: string | null;
  stage: AuditStage;
  role: Role;
  agentCmd: string;
  promptBytes: number;
  enabled: boolean;
}): RunHandle {
  if (!enabled || !stateDir) return NOOP;

  const at = new Date().toISOString();
  const startedAt = Date.now();

  return {
    finish({ exitCode, output }) {
      const usage = parseUsage(output);
      appendRunRecord(stateDir, ticketId, {
        at,
        kind: 'run',
        stage,
        role,
        agent: agentName(agentCmd),
        durationMs: Date.now() - startedAt,
        exitCode,
        promptBytes,
        // Null, not 0: output we never saw is unmeasured, not empty.
        responseBytes: output === null ? null : Buffer.byteLength(output),
        tokens: tokensOf(usage),
        tokenSource: usage?.source ?? null,
      });
      // This run has run files, so the close would record it a second time
      // off disk. It is saved; the row above is the better of the two.
      markRecorded(stateDir, ticketId, role);
    },
  };
}

// A prompt printed for the session to carry out. No process runs, so there is
// nothing to time and nothing to measure — but the run still happened, and
// without this the whole brainstorm-and-plan half of a ticket left no trace.
export function recordHandover({
  stateDir,
  ticketId,
  stage,
  role,
  promptBytes,
  note = null,
  enabled,
}: {
  stateDir: string | null;
  ticketId: string | null;
  stage: AuditStage;
  role: Role;
  // The text handed across the boundary. For a prompt that is the prompt; for
  // work the session did and then gave back, it is what came back.
  promptBytes: number;
  note?: string | null;
  enabled: boolean;
}): void {
  if (!enabled || !stateDir) return;
  // A run with files on disk is recorded at close, from those files — they
  // carry the duration and the log this side never sees. One row, not two.
  if (isTracked(stateDir, ticketId, role)) return;

  appendRunRecord(stateDir, ticketId, {
    at: new Date().toISOString(),
    kind: 'run',
    stage,
    role,
    agent: SESSION_AGENT,
    durationMs: null,
    exitCode: null,
    promptBytes,
    responseBytes: null,
    tokens: null,
    tokenSource: null,
    note,
  });
}

// Whether a run directory is already following this run.
function isTracked(stateDir: string | null, ticketId: string | null, role: Role): boolean {
  if (stateDir === null || ticketId === null) return false;
  return fs.existsSync(runFiles(stateDir, ticketId, role).startedAtPath);
}

// Marks a tracked run's ending as saved, so the close leaves it alone. The
// same marker `hasRecordedOutcome` reads.
function markRecorded(stateDir: string | null, ticketId: string | null, role: Role): void {
  if (stateDir === null || ticketId === null) return;
  if (!isTracked(stateDir, ticketId, role)) return;
  try {
    fs.writeFileSync(runFiles(stateDir, ticketId, role).recordedPath, '');
  } catch {
    // Same reason appendRunRecord swallows: bookkeeping must not fail a run.
  }
}

// Which command a background run belongs to.
function stageForRole(role: Role): AuditStage {
  if (role === ROLES.CODER) return AUDIT_STAGES.ERGON;
  if (role === ROLES.VERIFIER) return AUDIT_STAGES.VERIFY;
  return AUDIT_STAGES.REVIEW;
}

// A background run's spawning process is long gone, so everything comes off
// disk rather than from a timer held in memory.
export function recordBackgroundRun({
  stateDir,
  ticketId,
  role,
  enabled,
}: {
  stateDir: string;
  ticketId: string;
  role: Role;
  enabled: boolean;
}): void {
  if (!enabled) return;
  const { agentPath, promptPath, logPath, startedAtPath, exitCodePath, assumedExitPath } = runFiles(
    stateDir,
    ticketId,
    role,
  );
  // spawnBackground writes this as a millisecond epoch number, not an ISO
  // string, so it is read back as one — not with Date.parse.
  const startedAt = numberOrNull(startedAtPath);
  // When the run ENDED, not when someone got round to asking. The wrapper
  // writes the exit code as the process exits. A killed run never writes one,
  // so fall back to the log's last write — the agent's final sign of life.
  const endedAt = mtimeOr(exitCodePath, mtimeOr(logPath, Date.now()));
  const output = logTail(logPath);
  const usage = parseUsage(output);

  appendRunRecord(stateDir, ticketId, {
    at: new Date(startedAt ?? Date.now()).toISOString(),
    kind: 'run',
    stage: stageForRole(role),
    role,
    agent: readOr(agentPath, 'unknown').trim() || 'unknown',
    // Rounded: mtimeMs is fractional, and a permanent record does not need
    // eleven decimal places of a millisecond.
    durationMs: startedAt === null ? null : Math.round(Math.max(0, endedAt - startedAt)),
    // A missing exit-code file means the run never finished cleanly, not that
    // it exited 0 — Number('') is 0, so this cannot reuse readOr + Number.
    // A code glafka assumed is not a measurement either: nothing reported it.
    exitCode: fs.existsSync(assumedExitPath) ? null : numberOrNull(exitCodePath),
    promptBytes: sizeOr(promptPath),
    responseBytes: output === null ? null : Buffer.byteLength(output),
    tokens: tokensOf(usage),
    tokenSource: usage?.source ?? null,
  });
}

// A missing run file means we did not measure it, not that it was empty.
function readOr(filePath: string, fallback: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return fallback;
  }
}

// Null, not 0: a file we cannot stat is unmeasured, not empty.
function sizeOr(filePath: string): number | null {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return null;
  }
}

// Null for a missing or unreadable file. Number('') is 0, which would read as
// a real measurement, so a missing file cannot fall through readOr + Number.
// The file's last write time, or a fallback when it is not there.
function mtimeOr(filePath: string, fallback: number): number {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return fallback;
  }
}

function numberOrNull(filePath: string): number | null {
  const raw = readOr(filePath, '');
  if (raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}
