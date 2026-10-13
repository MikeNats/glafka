import { execFileSync } from 'node:child_process';

// Used to tell if a lock's owner is still alive.
// It has no imports, so both callers can use it freely.
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH means really dead.
    // Anything else means alive, just owned by someone else.
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

// `ps -o etime=` prints [[dd-]hh:]mm:ss — elapsed time since the process started. Supported by both BSD ps (macOS) and GNU ps (Linux CI), unlike
function parseEtimeMs(raw: string): number | null {
  const m = raw.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  const days = m[1] ? Number(m[1]) : 0;
  const hours = m[2] ? Number(m[2]) : 0;
  const minutes = Number(m[3]);
  const seconds = Number(m[4]);
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

// Windows has no `ps`, and the MSYS one Git for Windows ships does not accept `-o etime=`. PowerShell
// reports the start time directly, as a real timestamp rather than an elapsed span, so there is nothing to subtract.
function windowsStartTimeMs(pid: number): number | null {
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    // .NET ticks are 100ns units since 0001-01-01. 621355968000000000 of them
    // sit between that epoch and 1970-01-01.
    const ticks = BigInt(out.trim());
    return Number((ticks - 621355968000000000n) / 10000n);
  } catch {
    return null;
  }
}

// The OS's own record of when a pid started, independent of anything we wrote ourselves. A pid alone is not proof of identity: the OS recycles
export function processStartTimeMs(pid: number): number | null {
  if (process.platform === 'win32') return windowsStartTimeMs(pid);
  try {
    const out = execFileSync('ps', ['-o', 'etime=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const elapsedMs = parseEtimeMs(out);
    return elapsedMs == null ? null : Date.now() - elapsedMs;
  } catch {
    return null;
  }
}

// The process group a pid belongs to, or null when it cannot be established. `spawnBackground`
// starts every run with `detached: true`, which on posix makes the child a group LEADER — its pgid
// equals its own pid, and every descendant it starts inherits that pgid. So "is this call coming
// from inside that reviewer" is answerable as "is my pgid its pid". Windows has no
// process groups in this sense, so it returns null there and the caller treats the question as
// unanswerable rather than as a failure.
export function processGroupId(pid: number): number | null {
  if (process.platform === 'win32') return null;
  try {
    const out = execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const pgid = Number(out.trim());
    return Number.isInteger(pgid) && pgid > 0 ? pgid : null;
  } catch {
    return null;
  }
}

// `ps -o etime=` only has 1-second resolution, and there is always some delay between a process actually starting and either side reading it.
const START_TIME_TOLERANCE_MS = 5000;

export function sameProcessStart(a: number, b: number): boolean {
  return Math.abs(a - b) <= START_TIME_TOLERANCE_MS;
}
