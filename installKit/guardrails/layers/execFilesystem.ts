import type { Policy } from '../types/policy.js';
import type { Action } from '../types/action.js';
import type { Scopes } from '../types/scopes.js';
import type { Decision } from '../types/decision.js';
import type { LayerMeta } from '../types/layer.js';
import { checkPath } from './filesystem.js';
import { commandName } from './exec.js';

// LAYER: execFilesystem — the exec layer allow-lists commands like `cp`, `mv` and `cat` by NAME only; it never looks at the paths in their argv.

export const meta: LayerMeta = {
  name: 'execFilesystem',
  kind: 'doorman',
  rung: 4,
  what: 'applies the filesystem allow-root / denyWithin rules to path arguments of allow-listed commands',
  beatenBy: 'a command not in the tracked list below, or a shell string',
};

// Which commands touch paths given as plain arguments, and which check (read or write) those paths
// should get. When a command can do either Keep this in step with exec.allow in the level files: a
// command granted there but missing here has its paths checked by nobody.
const PATH_COMMANDS: Record<string, 'read' | 'write'> = {
  cp: 'write',
  mv: 'write',
  ln: 'write',
  rsync: 'write',
  tee: 'write',
  install: 'write',
  cat: 'read',
  mkdir: 'write',
  touch: 'write',
  make: 'write',
  ls: 'read',
  rg: 'read',
};

// For these the first bare word is a search pattern or a build target, not a
// path. Checking it would refuse ordinary work like `rg todo` or `make test`.
const FIRST_BARE_WORD_IS_NOT_A_PATH = new Set(['rg', 'make']);

// Flags whose VALUE is a path. Without naming them we would skip the flag and its value together,
// and `make -C /elsewhere` would go unchecked. `-t`/`--target-directory` is the one that matters
// for the copy family: it moves the DESTINATION out of its usual last-operand position and into a
// flag, so the scan below saw only the harmless source.
const TARGET_DIRECTORY = ['-t', '--target-directory'];
const PATH_FLAGS: Record<string, string[]> = {
  make: ['-C', '--directory', '-f', '--file', '--makefile'],
  cp: TARGET_DIRECTORY,
  mv: TARGET_DIRECTORY,
  ln: TARGET_DIRECTORY,
  install: TARGET_DIRECTORY,
};

// Reading from /dev/null is always empty — a common, harmless idiom that
// otherwise looks like "outside every allowed root".
const IGNORED_PATHS = new Set(['/dev/null', 'NUL']);

// `git` cannot use the generic walk below: its own subcommand decides whether a bare word is a path
// or a ref, so `git commit -m clone` must not read "clone" as a file while `git rm
// .claude/settings.json` must read it as one. Without this, `git` was on exec.allow at every level
// and its paths were checked by nobody, so `git rm`/`git checkout --`/`git restore` wrote straight
// through denyWithin. Every operand of these is a pathspec, never a ref.
const GIT_PATHSPEC_SUBCOMMANDS = new Set(['rm', 'mv', 'add', 'restore', 'clean']);

// `--source=main` takes a ref, not a path, so a flag VALUE is never a pathspec
// for git. Only bare operands are.
export function gitPathArguments(argv: string[]): string[] {
  const rest = argv.slice(1);

  // After `--`, everything is a pathspec whatever the subcommand was. This is
  // the `git checkout main -- <path>` form.
  const separator = rest.indexOf('--');
  if (separator !== -1) return rest.slice(separator + 1);

  const subcommand = rest.find((a) => !a.startsWith('-')) ?? null;
  if (subcommand === null || !GIT_PATHSPEC_SUBCOMMANDS.has(subcommand)) return [];

  // Everything bare after the subcommand itself.
  return rest.slice(rest.indexOf(subcommand) + 1).filter((a) => !a.startsWith('-'));
}

// Every argument that really names a path, in argv order.
export function pathArguments(name: string, rest: string[]): string[] {
  const pathFlags = PATH_FLAGS[name] ?? [];
  const skipFirstBare = FIRST_BARE_WORD_IS_NOT_A_PATH.has(name);
  const paths: string[] = [];
  let seenBare = false;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith('-')) {
      // The target or pattern comes first; anything after it is a real path.
      if (skipFirstBare && !seenBare) seenBare = true;
      else paths.push(arg);
      continue;
    }
    // `--file=x`, then `-C x`, then the joined short form `-Cx`.
    const joined = pathFlags.find((f) => arg.startsWith(`${f}=`));
    if (joined) {
      paths.push(arg.slice(joined.length + 1));
      continue;
    }
    if (pathFlags.includes(arg) && rest[i + 1] != null) {
      paths.push(rest[++i]);
      continue;
    }
    const short = pathFlags.find(
      (f) => /^-[A-Za-z]$/.test(f) && arg.startsWith(f) && arg.length > f.length,
    );
    if (short) paths.push(arg.slice(short.length));
  }

  return paths.filter((p) => !IGNORED_PATHS.has(p));
}

// A path the shell will build from a variable. We cannot know what it becomes,
// and `$HOME/pwned` is how anyone would naturally write the escape.
const VARIABLE_PATH = /^\$\{?[A-Za-z_]/;

// Looks like a path rather than a flag or a word: absolute, home-relative,
// variable-built, or containing a separator.
function looksLikeAPath(token: string): boolean {
  if (token.startsWith('-')) return false;
  return (
    token.startsWith('/') ||
    token.startsWith('~') ||
    VARIABLE_PATH.test(token) ||
    token.includes('/')
  );
}

// The coarse fallback for a line the tokenizer could not read (a `$VAR`, a `$( )`, a backtick). At
// level 2 such a line is still allowed to run, and this layer used to see no argv and answer
// "nothing to inspect" — so for paths the fallback was not a weaker check, it was NO check.
// It over-matches on purpose: a path inside a quoted commit message gets checked
// too. Over-matching in a fallback is the safe direction, and the only way to get here is "we could
// not read this properly" in the first place.
function checkCommandString(
  cfg: Policy['filesystem'],
  commandString: string,
  scopes: Scopes,
  cwd?: string,
): Decision {
  const words = commandString.split(/\s+/).filter(Boolean);
  if (words.length === 0) return { allow: true, reason: 'nothing to inspect' };

  const name = commandName(words[0]);
  const op = PATH_COMMANDS[name];
  if (!op) return { allow: true, reason: `"${name}" is not a tracked path command` };

  for (const token of words.slice(1)) {
    if (!looksLikeAPath(token)) continue;
    if (IGNORED_PATHS.has(token)) continue;
    // A variable cannot be resolved here, and resolving it wrongly is how this
    // escape worked: `$HOME/pwned` used to land "inside" the worktree.
    if (VARIABLE_PATH.test(token)) {
      return {
        allow: false,
        reason:
          `"${name}" is given a path built from a shell variable (${token}), which cannot be ` +
          `checked — write the path out, or run it as separate commands`,
      };
    }
    const decision = checkPath(cfg, op, token, scopes, cwd);
    if (!decision.allow) return decision;
  }
  return { allow: true, reason: 'no path in this line lands outside the allowed roots' };
}

export function check(policy: Policy, action: Action, scopes: Scopes, cwd?: string): Decision {
  const cfg = policy.filesystem;
  if (!cfg.enabled) return { allow: true, reason: 'filesystem layer off' };
  if (!('argv' in action) || !action.argv) {
    const commandString = 'commandString' in action ? action.commandString : undefined;
    if (commandString) return checkCommandString(cfg, commandString, scopes, cwd);
    return { allow: true, reason: 'not an argv-form exec action — nothing to inspect here' };
  }

  const argv = action.argv;
  if (argv.length === 0) return { allow: true, reason: 'empty command' };

  const name = commandName(argv[0]);

  // git gets its own extractor, because its subcommand decides what a bare word means. Its ops are all
  // writes: staging a denied file is the step that gets it pushed.
  if (name === 'git') {
    for (const candidate of gitPathArguments(argv)) {
      if (IGNORED_PATHS.has(candidate)) continue;
      const decision = checkPath(cfg, 'write', candidate, scopes, cwd);
      if (!decision.allow) return decision;
    }
    return { allow: true, reason: 'all git pathspecs stay inside the allowed roots' };
  }

  const op = PATH_COMMANDS[name];
  if (!op) return { allow: true, reason: `"${name}" is not a tracked path command` };

  const candidates = pathArguments(name, argv.slice(1));
  for (const candidate of candidates) {
    const decision = checkPath(cfg, op, candidate, scopes, cwd);
    if (!decision.allow) return decision;
  }

  return { allow: true, reason: 'all path arguments stay inside the allowed roots' };
}

export function describe(): string[] {
  return [
    `path arguments of ${Object.keys(PATH_COMMANDS).join(', ')} are checked against the same rules as Read/Write/Edit`,
  ];
}
