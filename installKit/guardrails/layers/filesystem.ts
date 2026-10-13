import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Policy } from '../types/policy.js';
import type { Action } from '../types/action.js';
import type { Scopes } from '../types/scopes.js';
import type { Decision } from '../types/decision.js';
import type { LayerMeta } from '../types/layer.js';

// LAYER: filesystem — keeps reads and writes inside the ticket's worktree.
// A child process can still get past it. This is a check, not a wall.

export const meta: LayerMeta = {
  name: 'filesystem',
  kind: 'doorman',
  rung: 4,
  what: "keeps file reads and writes inside the ticket's own worktree",
  beatenBy: 'a child process — see layers/sandbox.js',
};

// If the path has to go up (..) from the root, it is outside.
function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  if (rel === '') return true;
  return !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel);
}

// `~` is the shell's, not Node's: path.resolve has never heard of it, so `~/.ssh/id_rsa` used to
// resolve to a folder called "~" INSIDE the worktree and read as allowed, while the shell went to
// the real home folder. We expand it the way the shell does, before resolving.
// Returns null for the `~user` form. We cannot resolve another account's home reliably, and a path
// we cannot place is one we must not wave through.
export function expandTilde(target: string): string | null {
  if (target === '~') return os.homedir();
  if (!target.startsWith('~')) return target;
  if (target.startsWith('~/') || target.startsWith('~\\')) {
    return path.join(os.homedir(), target.slice(2));
  }
  return null;
}

// Follows links on the nearest folder that exists, and keeps the rest.
export function resolveHonestly(target: string): string {
  let head = path.resolve(target);
  const tail: string[] = [];

  for (;;) {
    if (fs.existsSync(head)) {
      return path.join(fs.realpathSync(head), ...tail);
    }
    const parent = path.dirname(head);
    // We reached the top, so stop.
    if (parent === head) return path.resolve(target);
    tail.unshift(path.basename(head));
    head = parent;
  }
}

// Matches file patterns. It supports **, * and ?.
export function globToRegExp(pattern: string): RegExp {
  let out = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        i += 1;
        if (pattern[i + 1] === '/') {
          // "**/" means any number of folders, including none. It must stop
          // at a slash, or it would also match inside a file name.
          out += '(?:.*/)?';
          i += 1;
        } else {
          // A "**" at the end really does mean everything below here.
          out += '.*';
        }
      } else {
        out += '[^/]*'; // a single * stops at a slash
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  // Case-insensitive: the common default volumes (macOS APFS, Windows NTFS) do not distinguish case, so a case-sensitive pattern here would be a
  return new RegExp(`${out}$`, 'i');
}

function matchesAny(relativePath: string, patterns: string[]): boolean {
  const posix = relativePath.split(path.sep).join('/');
  return patterns.some((p) => globToRegExp(p).test(posix));
}

// The path-checking core, shared by the filesystem layer itself and by execFilesystem (which applies the same rules to paths sitting inside an
export function checkPath(
  cfg: Policy['filesystem'],
  op: string,
  filePath: string | null,
  scopes: Scopes,
  cwd?: string,
): Decision {
  if (!filePath) {
    return {
      allow: false,
      reason: `${op} with no readable path — refusing rather than guessing what it meant`,
    };
  }

  // The shell expands `~` before the command ever runs, so we do it first too.
  const expanded = expandTilde(filePath);
  if (expanded === null) {
    return {
      allow: false,
      reason: `${op} names another account's home folder (${filePath}) — refusing rather than guessing where that is`,
    };
  }

  // A short path is worked out against the folder the ACTION came from,
  // not the folder this hook happens to run in.
  const absolute = path.resolve(cwd ?? process.cwd(), expanded);
  const target = cfg.followSymlinks ? resolveHonestly(absolute) : absolute;

  // Do the same for the roots. On macOS, /var is a link to /private/var.
  const roots = cfg.allowRoots
    .map((name) => scopes[name as keyof Scopes])
    .filter((root): root is string => Boolean(root))
    .map((root) => (cfg.followSymlinks ? resolveHonestly(root) : path.resolve(root)));

  // No root at all, so refuse.
  if (roots.length === 0) {
    return {
      allow: false,
      reason: 'no allowed root could be resolved for this ticket',
    };
  }

  const containing = roots.find((root) => isInside(root, target));
  if (!containing) {
    return {
      allow: false,
      reason: `${op} outside the ticket worktree: ${target}`,
    };
  }

  // Some files are still off limits, even inside the worktree.
  const relative = path.relative(containing, target);

  // This is our own file, not a project secret, so reading it is fine.
  if (relative === '.env.glafka' && op === 'read') {
    return { allow: true, reason: "glafka's own per-ticket env file, not a project secret" };
  }

  if (matchesAny(relative, cfg.denyWithin)) {
    return {
      allow: false,
      reason: `${op} blocked by denyWithin: ${relative}`,
    };
  }

  return { allow: true, reason: `inside ${containing}` };
}

// We test for filePath with 'in', because some actions,
// like running a command, have no file path at all.
export function check(policy: Policy, action: Action, scopes: Scopes, cwd?: string): Decision {
  const cfg = policy.filesystem;
  if (!cfg.enabled) return { allow: true, reason: 'filesystem layer off' };

  // No file path field at all means there is nothing to check. A field we
  // could not read is different: something was sent, and we refuse it.
  if (!('filePath' in action)) return { allow: true, reason: 'no path in this action' };
  return checkPath(cfg, action.op, action.filePath, scopes, cwd);
}

export function describe(policy: Policy, scopes: Partial<Scopes> = {}): string[] {
  const cfg = policy.filesystem;
  if (!cfg.enabled) return ['off — the agent may read and write anywhere'];

  const lines = [`may read and write inside:`];
  for (const name of cfg.allowRoots) {
    const value = scopes[name as keyof Scopes];
    lines.push(`    ${name}${value ? ` = ${value}` : ''}`);
  }
  lines.push(`  except these, even inside: ${cfg.denyWithin.length} pattern(s)`);
  lines.push(
    `    one built-in exception: .env.glafka may still be READ — it's glafka's own per-ticket file, not a project secret`,
  );
  lines.push(`  symlinks resolved first: ${cfg.followSymlinks ? 'yes' : 'NO — escapable'}`);
  return lines;
}
