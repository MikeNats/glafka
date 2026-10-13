import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// npm can print a lot. The default limit is too small and crashes it.
const MAX_NPM_OUTPUT_BYTES = 64 * 1024 * 1024;

// Only the one call shape this file uses.
// A fake runner in a test needs nothing more than this.
type RunNpmCommand = (
  file: string,
  args: readonly string[],
  options: { cwd: string; encoding: 'utf8'; maxBuffer: number },
) => string;

// Thrown when there is no npm project here. hygeia is npm-only, and running it anyway prints "found
// 0 vulnerabilities" about a dependency tree it never read — a security statement with nothing
// behind it — and drops a package-lock.json into a repo that has no Node in it.
export class NotAnNpmProjectError extends Error {
  constructor(cwd: string) {
    super(
      `no package.json in ${cwd} — hygeia only knows npm, so nothing was checked and nothing is proven.\n` +
        `  Python:  uv lock --upgrade && uv run pip-audit\n` +
        `  Rust:    cargo update && cargo audit\n` +
        `  Go:      go get -u ./... && govulncheck ./...\n` +
        `  run your ecosystem's equivalent yourself — glafka has no fallback here.`,
    );
    this.name = 'NotAnNpmProjectError';
  }
}

// Safe updates only. It never moves to a new major version.
export function hygeia({
  cwd,
  run = execFileSync,
  exists = fs.existsSync,
}: {
  cwd: string;
  run?: RunNpmCommand;
  exists?: (target: string) => boolean;
}): {
  updateLog: string;
  auditLog: string;
} {
  // Checked before either call. `npm audit` in a manifest-less directory succeeds and reports zero
  // vulnerabilities, which is the worst possible way to fail.
  if (!exists(path.join(cwd, 'package.json'))) throw new NotAnNpmProjectError(cwd);
  const options = { cwd, encoding: 'utf8' as const, maxBuffer: MAX_NPM_OUTPUT_BYTES };
  const updateLog = run('npm', ['update'], options);
  const auditLog = run('npm', ['audit', 'fix'], options);
  return { updateLog, auditLog };
}
