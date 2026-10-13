import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { listGitlinks, initSubmodules, checkoutBranchIn } from '../../util/git.js';
import { shellPath } from '../../util/shell.js';
import { parseEnvLines } from './ticketEnv.js';
import type { IsolationProfileLike } from './ticketEnv.js';

// Install commands can print more than Node's 1 MB default buffer.
// Past that, Node kills the child with a confusing error, so raise the limit.
const MAX_HOOK_OUTPUT_BYTES = 64 * 1024 * 1024;

// Default time limit for setupCmd and teardownCmd. It lives here so every
// hook has one. A hanging teardown would leave a ticket that never closes.
export const DEFAULT_ISOLATION_HOOK_TIMEOUT_MS = 5 * 60 * 1000;

interface RunHookOptions {
  cwd: string;
  env?: Record<string, string>;
  run?: typeof execFileSync;
  timeout?: number;
  // Which configured command this is, for the error message. The caller knows;
  // the runner does not, and "spawnSync sh ETIMEDOUT" never said.
  label?: string;
}

// How much of a hung command's output to show. Enough to see where it stopped,
// not so much that the real message scrolls away.
const FAILURE_OUTPUT_LINES = 40;

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

function lastLines(text: unknown, count: number): string | null {
  if (typeof text !== 'string' || text.trim() === '') return null;
  return text.trimEnd().split('\n').slice(-count).join('\n');
}

// Node throws `spawnSync /bin/sh ETIMEDOUT` and nothing else: not which command, not what it printed,
// not how long it ran. All three are in scope here, so put them in.
function runHookCommand(
  cmd: string,
  { cwd, env, run = execFileSync, timeout, label = 'hook' }: RunHookOptions,
): string {
  const startedAt = Date.now();
  try {
    return run(shellPath(), ['-c', cmd], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, ...env },
      maxBuffer: MAX_HOOK_OUTPUT_BYTES,
      ...(timeout ? { timeout } : {}),
    }) as string;
  } catch (err) {
    const failure = err as NodeJS.ErrnoException & {
      stdout?: unknown;
      stderr?: unknown;
      status?: number | null;
    };
    const elapsed = Date.now() - startedAt;
    const timedOut = failure.code === 'ETIMEDOUT';

    const lines = [
      timedOut
        ? `${label} timed out after ${formatDuration(elapsed)}` +
          (timeout ? ` (limit: ${formatDuration(timeout)})` : '')
        : `${label} failed after ${formatDuration(elapsed)}` +
          (failure.status == null ? '' : ` (exit ${failure.status})`),
      `  cwd: ${cwd}`,
      `  cmd: ${cmd}`,
    ];

    const output = lastLines(failure.stdout, FAILURE_OUTPUT_LINES);
    const errorOutput = lastLines(failure.stderr, FAILURE_OUTPUT_LINES);
    if (output) lines.push('', `  last output:`, output);
    if (errorOutput) lines.push('', `  last error output:`, errorOutput);
    if (!output && !errorOutput) lines.push('', '  it printed nothing before it stopped.');

    if (timedOut) {
      lines.push(
        '',
        '  Raise the limit in .glafka.json, or run the command by hand in that',
        '  folder to see where it hangs.',
      );
    }
    // The message is rebuilt, but the signal must survive it: `code` and `killed`
    // are how a caller tells a timeout from a plain failure.
    throw Object.assign(new Error(lines.join('\n'), { cause: err }), {
      code: failure.code,
      killed: (failure as { killed?: boolean }).killed,
      status: failure.status,
    });
  }
}

// Runs a setup or teardown hook. Output lines like KEY=VALUE come back,
// so a hook can hand us things like a DATABASE_URL. Throws if it fails.
export function runIsolationHook(cmd: string, options: RunHookOptions): Record<string, string> {
  return parseEnvLines(runHookCommand(cmd, { label: 'setupCmd', ...options }));
}

// This installs packages, so we do NOT read KEY=VALUE from its output.
// Package managers print lines in that shape by accident.
export function runBootstrap(cmd: string, options: RunHookOptions): void {
  runHookCommand(cmd, { label: 'bootstrapCmd', ...options });
}

// .env files are gitignored, so a new worktree has none and will not boot.
// Copies them over. Never overwrites, and skips files that are not there.
export function seedFiles(
  repoRoot: string,
  worktreeDir: string,
  relativePaths: string[] = [],
): string[] {
  const copied: string[] = [];
  for (const relative of relativePaths) {
    const source = path.join(repoRoot, relative);
    const destination = path.join(worktreeDir, relative);
    if (!fs.existsSync(source) || fs.existsSync(destination)) continue;
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
    copied.push(relative);
  }
  return copied;
}

// `git worktree add` leaves submodules empty, so we fill them here.
// Paths come from the git index, because .gitmodules can be out of date.
export function prepareSubmodules(
  repoRoot: string,
  worktreeDir: string,
  {
    workspace = {},
    branch,
  }: { workspace?: IsolationProfileLike['workspace']; branch?: string } = {},
): string[] {
  const configured = workspace?.submodules?.paths;
  const declared = configured ?? listGitlinks(repoRoot);
  if (declared.length === 0) return [];

  // A bad path would kill the whole ticket. Warn and skip it instead.
  const real = new Set(listGitlinks(repoRoot));
  const paths = declared.filter((p) => {
    if (real.has(p)) return true;
    process.stderr.write(
      `glafka: skipping "${p}" — declared in workspace.submodules but not a submodule in this repo\n`,
    );
    return false;
  });
  if (paths.length === 0) return [];

  initSubmodules(worktreeDir, paths);

  // Submodules start with no branch. You opt in, since a branch only helps
  // if the ticket commits inside the submodule.
  if (workspace?.submodules?.branchPerTicket && branch) {
    for (const relative of paths) checkoutBranchIn(path.join(worktreeDir, relative), branch);
  }
  return paths;
}
