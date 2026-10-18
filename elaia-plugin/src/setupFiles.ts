import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// The folders install writes into. Only glafka's own files in them are committed.
const SETUP_PLACES = [
  '.claude',
  '.cursor',
  '.opencode',
  '.gemini',
  '.kimi',
  '.kimi-code',
  '.github',
];
const GLAFKA_IGNORES = new Set(['.glafka/', '.worktrees/', '.env.glafka', '.elaia/']);
const git = (project: string, args: string[]) =>
  execFileSync('git', args, {
    cwd: project,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });

// .gitignore only when install's lines are its only change: never sweep in your own edits.
function gitignoreIsOurs(project: string, tracked: boolean): boolean {
  if (!tracked) {
    const lines = readFileSync(path.join(project, '.gitignore'), 'utf8').split('\n');
    return lines.every((l) => !l.trim() || GLAFKA_IGNORES.has(l.trim()));
  }
  const diff = git(project, ['diff', '-U0', '--', '.gitignore']).split('\n');
  const changed = diff.filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l));
  return changed.every((l) => l.startsWith('+') && GLAFKA_IGNORES.has(l.slice(1).trim()));
}

const isGlafkaFile = (file: string) =>
  file === '.glafka.json' ||
  file.startsWith('docs/glafka/') ||
  (SETUP_PLACES.some((dir) => file.startsWith(`${dir}/`)) &&
    file.split('/').some((part) => part === 'glafka' || part.startsWith('glafka-')));

// Files setup wrote that git does not have yet.
export function setupFiles(project: string): string[] {
  if (!existsSync(path.join(project, '.git'))) return [];
  let status: string;
  try {
    status = git(project, ['status', '--porcelain', '-z', '-uall']);
  } catch {
    return [];
  }
  const entries = status.split('\0').filter(Boolean);
  return entries.flatMap((entry) => {
    const file = entry.slice(3);
    if (file === '.gitignore')
      return gitignoreIsOurs(project, !entry.startsWith('??')) ? [file] : [];
    return isGlafkaFile(file) ? [file] : [];
  });
}
