import fs from 'node:fs';
import path from 'node:path';

// What a given agent harness cannot enforce, no matter what the level says. A level file describes
// the policy we WANT. It says nothing about whether the harness on the other side has an event we
// can say no on. Where those two disagree, the harness wins and the user has to be told — Cursor
// once silently had no roof while `filesystem.enabled: true` and `install cursor` both reported
// success.

// Cursor's only edit-time hook is `afterFileEdit`, which fires once the write has landed. There is
// no before-write event to refuse on, so the `filesystem` layer — the one that keeps a coder inside
// its own worktree — cannot block anything there at any level. We register `afterFileEdit` as a
// detector, so the write reaches the audit log, but it is not enforcement.
export const CURSOR_NO_WRITE_HOOK =
  'write confinement is NOT enforced on Cursor. It has no before-write hook, ' +
  'so the filesystem layer cannot stop a write at any level — afterFileEdit only ' +
  'records it afterwards, in the audit log. Shell, file reads and MCP calls ARE enforced.';

const CURSOR_HOOKS_PATH = path.join('.cursor', 'hooks.json');

interface CursorHooksFile {
  hooks?: Record<string, { command?: string }[]>;
}

// True when THIS repo has our Cursor hook wired up, so `--explain` only raises the caveat for a
// project that can actually be driven from Cursor. A parse failure counts as "not installed": a hooks.json we cannot read is one Cursor cannot read either.
export function cursorHookInstalled(repoRoot: string): boolean {
  const filePath = path.join(repoRoot, CURSOR_HOOKS_PATH);
  let parsed: CursorHooksFile;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as CursorHooksFile;
  } catch {
    return false;
  }
  return Object.values(parsed.hooks ?? {}).some((entries) =>
    (entries ?? []).some((entry) => (entry?.command ?? '').includes('--run-hook cursor')),
  );
}
