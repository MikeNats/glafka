import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The code graph tool: a static index of the code, no AI. Free, MIT, by DeusData.
// glafka installs one pinned version, so how it is called never changes under us.
export const CBM_NAME = 'codebase-memory-mcp';
export const CBM_VERSION = '0.12.0';

export class CbmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CbmError';
  }
}

export type CbmExec = (bin: string, args: string[], opts: object) => string;

export interface CbmOpts {
  exec?: CbmExec;
  // Where glafka's own copy lives. Tests point it somewhere empty.
  home?: string;
}

function stderrFrom(err: unknown): string {
  if (err && typeof err === 'object' && 'stderr' in err) {
    return String((err as { stderr: unknown }).stderr).trim() || String(err);
  }
  return err instanceof Error ? err.message : String(err);
}

const defaultExec: CbmExec = (bin, args, opts) =>
  execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });

export function cbmInstallDir(home = os.homedir()): string {
  return path.join(home, '.glafka', 'tools', CBM_NAME, CBM_VERSION);
}

export function cbmBinPath(home?: string): string {
  return path.join(
    cbmInstallDir(home),
    process.platform === 'win32' ? `${CBM_NAME}.exe` : CBM_NAME,
  );
}

// glafka's own copy first. One found on PATH is a version someone else chose.
function binFor(opts: CbmOpts): string {
  const own = cbmBinPath(opts.home);
  return fs.existsSync(own) ? own : CBM_NAME;
}

// Never throws: a tool that will not even start means "use the markdown map".
export function cbmAvailable(opts: CbmOpts = {}): boolean {
  const exec = opts.exec ?? defaultExec;
  try {
    exec(binFor(opts), ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

// One index per checkout: a ticket's worktree is its own project, never main's.
export function cbmProject(root: string): string {
  const real = fs.existsSync(root) ? fs.realpathSync(root) : root;
  const hash = crypto.createHash('sha1').update(real).digest('hex').slice(0, 8);
  const base = path.basename(real).replace(/[^A-Za-z0-9-]/g, '-');
  return `glafka-${base}-${hash}`;
}

function run(opts: CbmOpts, args: string[]): string {
  const exec = opts.exec ?? defaultExec;
  try {
    return exec(binFor(opts), ['cli', '--quiet', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (err: unknown) {
    throw new CbmError(stderrFrom(err));
  }
}

// Builds or refreshes the index. A refresh only re-reads what changed: about 2 s on glafka itself.
export function cbmIndexRepository(root: string, opts: CbmOpts = {}): void {
  const out = run(opts, [
    'index_repository',
    '--repo-path',
    root,
    '--name',
    cbmProject(root),
    '--mode',
    'moderate',
  ]);
  let status: unknown;
  try {
    status = (JSON.parse(out) as { status?: unknown }).status;
  } catch {
    throw new CbmError(`index_repository did not answer with JSON: ${out.slice(0, 200)}`);
  }
  if (status !== 'indexed') throw new CbmError(`index_repository ended "${String(status)}"`);
}

// Refreshed once per process: prompts are built at the start of a run, after the code last changed.
const refreshed = new Set<string>();

// One question to the graph about the code in `root`. `flags` use the tool's own names.
export function cbmQuery(
  root: string,
  tool: string,
  flags: Record<string, string>,
  opts: CbmOpts = {},
): string {
  if (!refreshed.has(root)) {
    cbmIndexRepository(root, opts);
    refreshed.add(root);
  }
  const args = [tool, '--project', cbmProject(root)];
  for (const [name, value] of Object.entries(flags)) args.push(`--${name}`, value);
  return run(opts, args);
}
