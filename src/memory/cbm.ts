import { execFileSync } from 'node:child_process';

const CBM_BIN = 'codebase-memory-mcp';

export class CbmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CbmError';
  }
}

export type CbmExec = (bin: string, args: string[], opts: object) => string;

function stderrFrom(err: unknown): string {
  if (err && typeof err === 'object' && 'stderr' in err) {
    return String((err as { stderr: unknown }).stderr).trim() || String(err);
  }
  return err instanceof Error ? err.message : String(err);
}

const defaultExec: CbmExec = (bin, args, opts) =>
  execFileSync(bin, args, { encoding: 'utf8', ...opts });

interface CbmOpts {
  exec?: CbmExec;
}

export function cbmAvailable(opts: CbmOpts = {}): boolean {
  const exec = opts.exec ?? defaultExec;
  try {
    exec(CBM_BIN, ['--help'], { stdio: 'ignore' });
    return true;
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      return false;
    }
    throw new CbmError(stderrFrom(err));
  }
}

export function cbmIndexRepository(repoRoot: string, opts: CbmOpts = {}): void {
  const exec = opts.exec ?? defaultExec;
  try {
    exec(CBM_BIN, ['index_repository', '--repo-root', repoRoot], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (err: unknown) {
    throw new CbmError(stderrFrom(err));
  }
}

export function cbmQuery(
  repoRoot: string,
  tool: string,
  args: Record<string, string>,
  opts: CbmOpts = {},
): string {
  const exec = opts.exec ?? defaultExec;
  const argv = [tool, '--repo-root', repoRoot];
  for (const [k, v] of Object.entries(args)) {
    argv.push(`--${k}`, v);
  }
  try {
    return exec(CBM_BIN, argv, { maxBuffer: 64 * 1024 * 1024 }).trimEnd();
  } catch (err: unknown) {
    throw new CbmError(stderrFrom(err));
  }
}
