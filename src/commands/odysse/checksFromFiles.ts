import fs from 'node:fs';
import path from 'node:path';
import { readDoc, workspaceProposalPath, writeDoc } from '../../memory/docsStore.js';

// Files that mean "read me first": a task runner or a workspace. With one of these, the
// package.json scripts may not be how this project runs its checks, so an agent reads them.
const ASK_AN_AGENT = [
  'run',
  'Makefile',
  'makefile',
  'GNUmakefile',
  'justfile',
  'Justfile',
  'Taskfile.yml',
  'Taskfile.yaml',
  'pnpm-workspace.yaml',
];

const LOCKFILES: Array<[string, string]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
];

// A script that already runs the tests, so `check && test` would run them twice.
const RUNS_TESTS = /\b(test|vitest|jest|mocha|ava|tap|playwright)\b/;
// npm init's placeholder: a test script that only fails.
const PLACEHOLDER = /no test specified/;

function scriptsOf(repoRoot: string): Record<string, string> | null {
  const file = path.join(repoRoot, 'package.json');
  if (!fs.existsSync(file)) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      scripts?: Record<string, string>;
      workspaces?: unknown;
    };
    if (pkg.workspaces) return null;
    const scripts = { ...(pkg.scripts ?? {}) };
    if (scripts.test && PLACEHOLDER.test(scripts.test)) delete scripts.test;
    return scripts;
  } catch {
    return null;
  }
}

// The check command, read from package.json with no agent. Null when it is not that simple.
export function checksFromFiles(repoRoot: string): { checksCmd: string; e2eCmd?: string } | null {
  if (ASK_AN_AGENT.some((name) => fs.existsSync(path.join(repoRoot, name)))) return null;
  const scripts = scriptsOf(repoRoot);
  if (!scripts) return null;
  const pm = LOCKFILES.find(([lock]) => fs.existsSync(path.join(repoRoot, lock)))?.[1] ?? 'npm';
  const has = (name: string) => Boolean(scripts[name]);
  const names = has('check')
    ? ['check', ...(has('test') && !RUNS_TESTS.test(scripts.check!) ? ['test'] : [])]
    : ['lint', 'typecheck', 'test'].filter(has);
  if (names.length === 0) return null;
  const checksCmd = names.map((name) => `${pm} run ${name}`).join(' && ');
  const e2e = ['test:e2e', 'e2e'].find(has);
  return e2e ? { checksCmd, e2eCmd: `${pm} run ${e2e}` } : { checksCmd };
}

// Adds what was found to the scan's proposals, keeping every key already there.
export function proposeChecks(repoRoot: string, found: { checksCmd: string; e2eCmd?: string }) {
  const file = workspaceProposalPath(repoRoot);
  const old = fs.existsSync(file) ? (JSON.parse(readDoc(file)) as Record<string, unknown>) : {};
  writeDoc(file, `${JSON.stringify({ ...old, ...found }, null, 2)}\n`);
}
