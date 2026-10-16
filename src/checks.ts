import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { NEVER_REDACTED } from '../installKit/guardrails/index.js';
import type { CheckResult, ChecksVerdict } from './types/checks.js';
import { shellArgv } from './util/shell.js';
import { readTicketEnv } from './ticket/resources/ticketEnv.js';
import { nodeProblem } from './util/nodeVersion.js';

// runNamed takes the file and its args separately, so split the shell argv.
const shellArgvSplit = (cmd: string): [string, string[]] => {
  const [file, ...args] = shellArgv(cmd);
  return [file!, args];
};

// Only for Node projects. Other languages have no such scripts.
// `odysse --checks` finds the real command for them.
const NODE_CONVENIENCE_SCRIPTS = ['lint', 'typecheck', 'test'];

const SECRET_ENV_NAME_RE = /SECRET|TOKEN|PASS|PWD|KEY|CREDENTIAL|AUTH/i;
const URL_CREDENTIALS_RE = /:\/\/[^\s/:@]+:[^\s/:@]+@/g;
// We skip short values like "ok", or normal words would look like secrets.
const MIN_SECRET_LENGTH = 4;

const execFileAsync = promisify(execFile);

// Node's default 1 MB limit is too small for noisy test output.
// Past the limit Node kills the process, and a pass looks like a fail.
const MAX_CHECK_OUTPUT_BYTES = 64 * 1024 * 1024;

interface RunOptions {
  cwd: string;
  encoding: 'utf8';
  timeout: number | null;
  env: NodeJS.ProcessEnv;
}

// Fake runners in tests return plain text, not always a promise.
export type RunFn = (cmd: string, args: string[], options: RunOptions) => string | Promise<string>;

interface ChildProcessLikeError extends Error {
  code?: string;
  killed?: boolean;
  stdout?: string;
  stderr?: string;
}

// Default runner. Tests can pass a fake one instead.
const defaultRun: RunFn = async (cmd, args, options) => {
  const { stdout } = await execFileAsync(cmd, args, {
    maxBuffer: MAX_CHECK_OUTPUT_BYTES,
    ...options,
    timeout: options.timeout ?? undefined,
  });
  return stdout;
};

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Hides values that look like secrets. We rebuild the list every call,
// because a new secret can appear while we run.
function redactSecrets(output: string): string {
  const values: string[] = [];
  for (const [name, value] of Object.entries(process.env)) {
    if (!value || value.length < MIN_SECRET_LENGTH) continue;
    // Check the never-hide list first. `PWD` looks like a secret by name,
    // but it is the current folder, so hiding it would hide every path.
    if (NEVER_REDACTED.has(name) || !SECRET_ENV_NAME_RE.test(name)) continue;
    values.push(value);
  }

  let redacted = output;
  if (values.length > 0) {
    // Match the longest secrets first, or a short one would hide
    // only part of a longer one.
    const pattern = values
      .sort((a, b) => b.length - a.length)
      .map(escapeForRegExp)
      .join('|');
    redacted = redacted.replace(new RegExp(pattern, 'g'), '[REDACTED]');
  }
  return redacted.replace(URL_CREDENTIALS_RE, '://[REDACTED]@');
}

async function runNamed(
  name: string,
  cmd: string,
  args: string[],
  cwd: string,
  run: RunFn,
  timeout: number | null,
  env: NodeJS.ProcessEnv,
): Promise<CheckResult> {
  try {
    const output = await run(cmd, args, { cwd, encoding: 'utf8', timeout, env });
    return { name, passed: true, output: redactSecrets(output) };
  } catch (err) {
    const error = err as ChildProcessLikeError;
    // A timeout shows up in two ways, so we check both.
    if (error.code === 'ETIMEDOUT' || error.killed === true) {
      return { name, passed: false, output: `timed out after ${timeout}ms` };
    }
    // Too much output is not a failure. Node cuts it off, so we do not know
    // the result. Calling it FAILED would be a lie that never clears.
    if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      return {
        name,
        passed: false,
        unknown: true,
        output:
          `output exceeded ${MAX_CHECK_OUTPUT_BYTES} bytes, so the run was cut off before it ` +
          `finished — this is NOT a failure, and NOT a pass: the result is unknown.\n` +
          `  make the command quieter (a non-verbose or reporter flag), then re-run.\n` +
          `--- first ${MAX_CHECK_OUTPUT_BYTES} bytes of output ---\n${redactSecrets(error.stdout ?? '')}`,
      };
    }
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}` || error.message;
    return { name, passed: false, output: redactSecrets(output) };
  }
}

// Three states, not two. An empty list is NOT a pass. It means nothing
// was checked, and that must never read as "all good".
export const CHECK_VERDICT: {
  PASSED: ChecksVerdict;
  FAILED: ChecksVerdict;
  UNKNOWN: ChecksVerdict;
} = Object.freeze({
  PASSED: 'passed',
  FAILED: 'failed',
  UNKNOWN: 'unknown',
});

export function checksVerdict(checks: CheckResult[]): ChecksVerdict {
  if (checks.length === 0) return CHECK_VERDICT.UNKNOWN;
  // A real failure always wins. Unknown only wins if nothing failed.
  if (checks.some((c) => !c.passed && !c.unknown)) return CHECK_VERDICT.FAILED;
  if (checks.some((c) => c.unknown)) return CHECK_VERDICT.UNKNOWN;
  return CHECK_VERDICT.PASSED;
}

// Which convenience scripts the zero-config fallback would actually run here. Named, not just
// counted, so a caller can say out loud what it is about to spend minutes on.
export function guessableChecks(cwd: string): string[] {
  const pkgPath = path.join(cwd, 'package.json');
  if (!fs.existsSync(pkgPath)) return [];
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
      scripts?: Record<string, unknown>;
    };
    return NODE_CONVENIENCE_SCRIPTS.filter((name) => Boolean(pkg.scripts?.[name]));
  } catch {
    return [];
  }
}

// Says why nothing ran, and how to fix it. It never guesses a command,
// because a wrong guess looks far too trustworthy.
export function explainNoChecks(cwd: string | null): string {
  const hasNodeManifest = cwd !== null && fs.existsSync(path.join(cwd, 'package.json'));
  const why = hasNodeManifest
    ? `no "checksCmd" is configured, and this project's package.json defines none of ` +
      `${NODE_CONVENIENCE_SCRIPTS.join('/')} (the only zero-config path glafka has, ` +
      `and a Node-only one)`
    : `no "checksCmd" is configured, and this is not a single-package Node project, ` +
      `so glafka has nothing to fall back on`;

  return (
    `${why}. Nothing was run, so nothing is proven.\n` +
    `  find the real command:  glafka odysse --checks   (finds it, once)\n` +
    `  or set it by hand:      "checksCmd" in .glafka.json`
  );
}

// A set checksCmd wins over the auto-detected scripts. e2eCmd always runs.
// Checks run one at a time, and a time limit stops one hanging forever.
export async function runChecks(
  cwd: string,
  {
    run = defaultRun,
    checksCmd = null,
    e2eCmd = null,
    checksTimeoutMs = null,
    e2eTimeoutMs = null,
    untrustedPackageJson = false,
    hostExecutingChanges = [],
  }: {
    run?: RunFn;
    checksCmd?: string | null;
    e2eCmd?: string | null;
    checksTimeoutMs?: number | null;
    e2eTimeoutMs?: number | null;
    // True when this branch's own diff touched package.json. The npm fallback below runs "scripts" straight off that file, on the host,
    untrustedPackageJson?: boolean;
    // Changed files that hostexec flags as running on the host. runChecks is glafka's own host-side call
    // — it never goes through spawnBackground, so there is no sandbox around it at ANY level.
    hostExecutingChanges?: string[];
  } = {},
): Promise<CheckResult[]> {
  // A Node too old for the project fails every check for a reason no coder can fix. Stop and say so.
  const tooOld = nodeProblem(cwd);
  if (tooOld) throw new Error(tooOld);
  const results: CheckResult[] = [];
  // The ports and connection strings provisioning left in this worktree. A ticket gets its
  // own database, and the tests meant to use it could not reach it: only the dev-server
  // starter ever read this file. Ticket values beat the ambient shell, the same way the
  // isolation hooks already do — an exported DB_PORT must never silently defeat isolation.
  const env: NodeJS.ProcessEnv = { ...process.env, ...readTicketEnv(cwd) };

  // Checked before either branch, not inside the fallback. The guard used to sit in the `else if`,
  // which is the one branch skipped whenever the recommended configuration (an explicit checksCmd)
  // is used — and a checksCmd like "npm test" runs the branch's own committed scripts just the same.
  if (hostExecutingChanges.length > 0) {
    return [
      {
        name: 'checks',
        passed: false,
        unknown: true,
        output:
          `${hostExecutingChanges.length} changed file(s) in this branch RUN ON YOUR MACHINE, ` +
          `outside every cage, and running the checks would execute them unattended from a diff ` +
          `nobody has reviewed yet. This is NOT a failure, and NOT a pass: the result is unknown.\n` +
          hostExecutingChanges.map((p) => `    ${p}`).join('\n') +
          `\n  read those files, then re-run.`,
      },
    ];
  }

  if (checksCmd) {
    results.push(
      await runNamed('checks', ...shellArgvSplit(checksCmd), cwd, run, checksTimeoutMs, env),
    );
  } else if (untrustedPackageJson) {
    results.push({
      name: 'package.json',
      passed: false,
      unknown: true,
      output:
        `package.json was changed in this branch, so its scripts are not run automatically — ` +
        `they would run on the host, unattended, straight from a diff nobody has reviewed yet. ` +
        `This is NOT a failure, and NOT a pass: the result is unknown.\n` +
        `  review the diff to package.json first, then set an explicit "checksCmd" ` +
        `in .glafka.json to run it yourself.`,
    });
  } else {
    const pkgPath = path.join(cwd, 'package.json');
    if (fs.existsSync(pkgPath)) {
      // A broken package.json is a FAILED CHECK, not an error we throw.
      // Throwing here used to restart the coder forever.
      let scripts: Record<string, unknown> = {};
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
          scripts?: Record<string, unknown>;
        };
        scripts = pkg.scripts ?? {};
      } catch (err) {
        results.push({
          name: 'package.json',
          passed: false,
          output: `package.json could not be read: ${(err as Error).message}`,
        });
      }
      for (const name of NODE_CONVENIENCE_SCRIPTS) {
        if (scripts[name]) {
          const result = await runNamed(
            name,
            'npm',
            ['run', '--silent', name],
            cwd,
            run,
            checksTimeoutMs,
            env,
          );
          // Say where the command came from. Nobody configured this one — glafka guessed it off
          // package.json — so a failure here is often a script that was already failing on the base
          // branch, not something this ticket broke. Without the note, the coder is sent back to
          // fix code it never wrote.
          if (!result.passed) {
            result.output =
              `${result.output}\n\n` +
              `[this check was not configured — glafka ran "npm run ${name}" because package.json ` +
              `defines it. If it already failed on the base branch, set "checksCmd" in .glafka.json ` +
              `(or run \`glafka odysse --checks\`) so the real command is used instead.]`;
          }
          results.push(result);
        }
      }
    }
  }

  if (e2eCmd) {
    results.push(await runNamed('e2e', ...shellArgvSplit(e2eCmd), cwd, run, e2eTimeoutMs, env));
  }

  return results;
}
