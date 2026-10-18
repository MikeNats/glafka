import { execFile } from 'node:child_process';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

const MAX_OUTPUT = 32 * 1024 * 1024;

// Runs glafka inside one project. Never throws for a non-zero exit; the caller decides.
export function runGlafka(
  bin: string,
  args: string[],
  cwd: string,
  timeoutMs = 120_000,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      // Elaia starts this plugin with a clean environment; glafka gets the same one.
      { cwd, timeout: timeoutMs, maxBuffer: MAX_OUTPUT },
      (err, stdout, stderr) => {
        const missing = err && 'code' in err && err.code === 'ENOENT';
        if (missing) {
          reject(
            new Error(
              `glafka was not found at "${bin}". Install it, or set GLAFKA_BIN in the glafka plugin's env.`,
            ),
          );
          return;
        }
        const code = err && typeof err.code === 'number' ? err.code : err ? 1 : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}
