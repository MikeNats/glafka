import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs';
import path from 'node:path';

// glafka's own files that Elaia reads. Kept in one place, so a layout change is one fix.
export const glafkaDir = (project: string) => path.join(project, '.glafka');

// glafka puts every ticket's worktree here, inside the repo.
export const WORKTREES_DIR = '.worktrees';

// The writes that mean a ticket moved. Logs and tool audits change constantly and mean nothing.
export const TICKET_FILES = /(^|[\\/])(ticket\.json|stages|exit-code)$/;
export const isTicketChange = (relativePath: string) => TICKET_FILES.test(relativePath);

export interface EndedRun {
  role: string;
  startedAt: string;
  log: string;
  exitCode: number | null;
}

// Background runs that ended, with their exit code (null when killed or crashed). glafka
// deletes them at close, so copy them first.
export function endedRuns(project: string, ticketId: string): EndedRun[] {
  const runs = path.join(glafkaDir(project), 'tickets', ticketId, 'runs');
  let roles: string[];
  try {
    roles = readdirSync(runs);
  } catch {
    // No runs yet, or glafka deleted them at close.
    return [];
  }
  return roles.flatMap((role) => {
    try {
      return endedRun(path.join(runs, role), role);
    } catch {
      // Deleted while we read it (glafka lysis). The next refresh looks again.
      return [];
    }
  });
}

// glafka's own check: EPERM means alive, owned by someone else. Only ESRCH means gone.
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// How a run ended, as glafka judges it: its exit code, or null when its process is gone with no
// code (killed, timed out and stopped, crashed). Undefined while it still runs.
function exitCodeOf(dir: string): number | null | undefined {
  const codeFile = path.join(dir, 'exit-code');
  const pidFile = path.join(dir, 'pid');
  if (!existsSync(codeFile)) {
    // No pid: a run started outside glafka, which ends only with an exit code.
    if (!existsSync(pidFile) || isAlive(Number(readFileSync(pidFile, 'utf8')))) return undefined;
    // It may have written its code just before it ended.
    if (!existsSync(codeFile)) return null;
  }
  const code = Number(readFileSync(codeFile, 'utf8').trim());
  return Number.isNaN(code) ? null : code;
}

function endedRun(dir: string, role: string): EndedRun[] {
  const log = path.join(dir, 'log');
  if (!existsSync(log)) return [];
  const exitCode = exitCodeOf(dir);
  if (exitCode === undefined) return [];
  const startedFile = path.join(dir, 'started-at');
  const startedAt = existsSync(startedFile)
    ? readFileSync(startedFile, 'utf8').trim()
    : String(Math.round(statSync(log).mtimeMs));
  return [{ role, startedAt, log, exitCode }];
}

const TAIL_BYTES = 256 * 1024;

// The end of a log, without reading all of it (a coder's log can be many megabytes).
function tailOf(logPath: string): string {
  const fd = openSync(logPath, 'r');
  try {
    const size = fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(TAIL_BYTES, size));
    readSync(fd, buffer, 0, buffer.length, size - buffer.length);
    return buffer.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

// The agent's own closing words, from the last result line of a stream-json log.
export function lastResult(logPath: string): string | null {
  const text = tailOf(logPath);
  const lines = text.split('\n').reverse();
  for (const line of lines) {
    if (!line.includes('"type":"result"')) continue;
    try {
      const json = JSON.parse(line) as { result?: unknown };
      if (typeof json.result === 'string') return json.result;
    } catch {
      // A cut line at the start of the tail. Keep looking.
    }
  }
  return null;
}
