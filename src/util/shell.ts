import fs from 'node:fs';
import path from 'node:path';

// Every command glafka runs on your behalf — checksCmd, e2eCmd, the agent commands,
// setupCmd/teardownCmd, notifyCmd — is a shell string you wrote once, in .glafka.json or an
// isolation profile. They read like shell: pipes, `&&`, quoting, `$VARS`. So on Windows we look for
// a POSIX shell rather than handing those strings to cmd.exe. Running them through cmd would not
// fail loudly; it would silently mean something else, and a `checksCmd` that quietly stops checking
// is worse than one that refuses to start. Git for Windows ships bash, and anyone using glafka
// already has git.

export const WINDOWS_BASH_CANDIDATES = [
  // Git for Windows, default and 32-bit install locations.
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  // WSL's bash. Last, because its filesystem view differs from the host's.
  'C:\\Windows\\System32\\bash.exe',
];

// Set this to point at a shell somewhere else.
const SHELL_ENV_VAR = 'GLAFKA_SHELL';

let cached: string | null = null;

export class NoShellError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoShellError';
  }
}

// Where the POSIX shell is. `sh` everywhere except Windows, where it is a
// real path we had to go and find.
export function shellPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[SHELL_ENV_VAR];
  if (override) return override;
  if (process.platform !== 'win32') return 'sh';

  if (cached) return cached;

  for (const candidate of WINDOWS_BASH_CANDIDATES) {
    if (fs.existsSync(candidate)) {
      cached = candidate;
      return candidate;
    }
  }

  // Fall back to PATH. A bash on PATH is a bash, wherever it came from.
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'bash.exe');
    if (fs.existsSync(candidate)) {
      cached = candidate;
      return candidate;
    }
  }

  throw new NoShellError(
    'glafka needs a POSIX shell to run the commands in your config (checksCmd, the agent ' +
      'commands, setupCmd), and none was found on this machine.\n' +
      '  Install Git for Windows, which ships bash: https://git-scm.com/download/win\n' +
      `  Or point ${SHELL_ENV_VAR} at a shell you already have.\n` +
      'cmd.exe is not used on purpose: it would run those commands with different ' +
      'meaning rather than refusing, and a check that quietly stops checking is worse ' +
      'than one that will not start.',
  );
}

// argv for running one command string through the shell.
export function shellArgv(command: string, env: NodeJS.ProcessEnv = process.env): string[] {
  return [shellPath(env), '-c', command];
}
