import path from 'node:path';

import type { Policy } from '../types/policy.js';
import type { Action } from '../types/action.js';
import type { Decision } from '../types/decision.js';
import type { LayerMeta } from '../types/layer.js';

// LAYER: exec — only lets commands on the allow list run.
// A script file can get past it. Level 3 and up refuse shell strings.

export const meta: LayerMeta = {
  name: 'exec',
  kind: 'doorman',
  rung: 4,
  what: 'only lets named commands run',
  beatenBy: 'a script file the agent wrote itself — see layers/sandbox.js',
};

// Drops the folder, so "/usr/bin/curl" becomes "curl". Drops ".exe" too. Exported because the
// network layer needs the same answer: it used to split on "/" alone, so `curl.exe` and
// `C:\...\curl.exe` were not recognised as curl at all — which on Windows, where `curl.exe` is the
// normal name, meant the network layer did nothing.
export function commandName(argv0: string): string {
  // Both separators, on every platform. path.basename follows the HOST's rules, so on macOS it
  // reads `C:\Windows\System32\curl.exe` as one long filename and the name never matches "curl".
  // Splitting on both makes the answer the same everywhere, and it can only ever make a name
  // shorter — which makes the never-list match more often, never less.
  const base = argv0.split(/[/\\]/).pop() ?? argv0;
  return base.replace(/\.exe$/i, '');
}

// What may sit immediately before a never-listed word for it to still count as that command. `/`
// belongs here: `/usr/bin/git push` runs git, and excluding the slash meant every never-entry could
// be stepped around by writing the command with a directory in front of it. A word
// character still blocks the match, so `mygit push` is not `git push`.
const NOT_A_WORD_CHAR = '[^\\w]';

// Turns a banned entry into a pattern, for a command we could not split
// into words. Anything may sit between the words, on purpose.
function neverEntryPattern(entry: string): RegExp {
  const words = entry.trim().split(/\s+/);
  return new RegExp(`(^|${NOT_A_WORD_CHAR})${words.join('[\\s\\S]*?')}(\\s|$)`);
}

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// True if every word of a banned entry is somewhere in the string, in ANY
// order. Only used on strings we already know we can not read properly.
function hidesNeverEntry(entry: string, commandString: string): boolean {
  return entry
    .trim()
    .split(/\s+/)
    .every((word) =>
      new RegExp(`(^|${NOT_A_WORD_CHAR})${escapeForRegExp(word)}([^\\w]|$)`).test(commandString),
    );
}

// Commands that take an argument and RUN it as a command. Only for these is an argument with spaces really a hidden command. Everything else is text,
const RUNS_ITS_ARGUMENT = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'env',
  'xargs',
  'ssh',
  'nohup',
  'timeout',
  'nice',
  // Same shape: each one hands the rest of the line to another program.
  'sudo',
  'doas',
  'setsid',
  'stdbuf',
  'script',
  'flock',
  'time',
  'watch',
]);

// True if a banned entry's words appear in order in the command,
// even with flags between them or another command in front.
function matchesNeverEntry(entry: string, argv: string[]): boolean {
  const wanted = entry.trim().split(/\s+/);
  const strings = argv.filter((a) => typeof a === 'string');

  for (let start = 0; start < strings.length; start++) {
    // Case-folded, same reason as the network layer: this is the never list, so matching more is
    // the safe direction. The ALLOW list below deliberately does NOT fold case — on Linux `NODE` is
    // a different binary from `node`, and allowing it because of a filename convention from another
    // OS would be a real hole.
    if (commandName(strings[start]).toLowerCase() !== wanted[0]!.toLowerCase()) continue;

    let cursor = start + 1;
    let hit = true;
    for (let w = 1; w < wanted.length; w++) {
      const idx = strings.indexOf(wanted[w], cursor);
      if (idx === -1) {
        hit = false;
        break;
      }
      cursor = idx + 1;
    }
    if (hit) return true;
  }

  // The loop above can not see inside `sh -c "git push origin main"`,
  // because the whole command is one argument. This second pass handles that.
  if (strings.length === 0 || !RUNS_ITS_ARGUMENT.has(commandName(strings[0]))) return false;
  const pattern = neverEntryPattern(entry);
  return strings.slice(1).some((a) => a.includes(' ') && pattern.test(a));
}

// These git options point git at a DIFFERENT repo. The scan below skips flags, so it would allow
// the action while it lands somewhere else. `-C` is the short one and takes a path, attached or
// separate, so we match the prefix. Without it, `git -C ~/other-repo clean -fdx` lands outside.
const GIT_REPO_SELECTING = /^(-C|--(git-dir|work-tree|exec-path|namespace|super-prefix)(=|$))/;

// These git options run an ARBITRARY SHELL COMMAND themselves, or set arbitrary config (which can do the same via core.fsmonitor / core.pager /
const GIT_SHELLS_OUT = /^(-x$|--exec(=|$)|-c$|--config(-env)?(=|$))/;

// These git subcommands take their SOURCE or DESTINATION as a bare positional argument, not as a
// flag. GIT_REPO_SELECTING above only matches flags, and `git` is not in execFilesystem's
// PATH_COMMANDS, so nothing else looks at where they land: `git clone . ~/pwned` and `git
// checkout-index --prefix=/etc/` both write outside filesystem.allowRoots, which is
// neverOverridable at every level. None of them is work a coder does inside a worktree it did not
// create.
const GIT_LEAVES_THE_WORKTREE = new Set([
  'clone',
  'init',
  'worktree',
  'checkout-index',
  'archive',
  'bundle',
]);

// git's own subcommand: the first argument that is not a flag. Flags before it (`--no-pager`,
// `--literal-pathspecs`) are skipped, and the repo-selecting and shell-out forms are refused separately above.
function gitSubcommand(argv: string[]): string | null {
  return argv.slice(1).find((a) => !a.startsWith('-')) ?? null;
}

// These git subcommands ALSO take a repository or destination as a bare positional — but unlike
// GIT_LEAVES_THE_WORKTREE they have an everyday form that stays inside (`git fetch origin`, `git
// submodule add <url> vendor/x`). Denying the subcommand outright would take ordinary work away, so
// each positional is judged instead.
const GIT_SUBS_WITH_PATH_ARGS = new Set(['fetch', 'submodule']);

// A positional that names somewhere on this disk OUTSIDE the current tree. Deliberately syntactic —
// the exec layer is not given the worktree path, and a syntactic answer is the one that cannot go
// wrong in the loose direction:
//   /Users/victim/repo   absolute        → outside
//   ~/repo                home            → outside
//   ../other-repo        climbs out      → outside
//   file:///Users/…      local by URL    → outside
//   origin, upstream     a remote NAME   → fine
//   https://…, git@…:…   a real remote   → fine, the network layer's job
//   vendor/x, ./sub      stays inside    → fine
function leavesTheTreeAsPath(arg: string): boolean {
  if (arg.startsWith('file://')) return true;
  // A scheme (https://, ssh://) or scp-style `user@host:path` is a remote, not a local path. Checked
  // before the separator rules, or `git@github.com:a/b` would read as a relative path.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(arg) || /^[^/]+@[^/]+:/.test(arg)) return false;
  if (path.isAbsolute(arg) || arg.startsWith('~')) return true;
  // Windows drive letters and UNC paths, which path.isAbsolute misses on posix.
  if (/^[a-zA-Z]:[\\/]/.test(arg) || arg.startsWith('\\\\')) return true;
  return arg.split(/[/\\]/).includes('..');
}

// An exact match is not enough: `-f` and `--force` mean the same thing, and short flags can be joined together, like `-fd`. A long flag also
function matchesDenyArg(bad: string, argv: string[]): boolean {
  if (/^-[A-Za-z]$/.test(bad)) {
    const letter = bad[1];
    return argv.some((a) => /^-[A-Za-z]+$/.test(a) && a.slice(1).includes(letter));
  }
  return argv.some((a) => a === bad || a.startsWith(`${bad}=`));
}

// We test for the field with 'in', because an action carries
// either a command string or an argument list, never both.
export function check(policy: Policy, action: Action): Decision {
  const cfg = policy.exec;
  if (!cfg.enabled) return { allow: true, reason: 'exec layer off' };

  const commandString = 'commandString' in action ? action.commandString : undefined;
  const argvField = 'argv' in action ? action.argv : undefined;

  // A shell string, not an argv array.
  if (commandString != null && argvField == null) {
    if (!cfg.allowShellStrings) {
      return {
        allow: false,
        reason:
          'shell strings are refused at this level — pass an argv array instead ' +
          '(a string cannot be checked reliably: quotes, $(), ;, && all hide things)',
      };
    }
    // We only get here for a string we could not split into words. A variable can hide part of it, so word ORDER means nothing. We look for the words
    const hit = cfg.never.find((entry) => hidesNeverEntry(entry, commandString));
    if (hit) {
      return {
        allow: false,
        reason:
          `this command cannot be read (a variable or an expansion hides part of it), ` +
          `and every word of a never-allowed action is in it: ${hit} — ` +
          `rewrite it without the expansion so it can be checked properly`,
      };
    }
    return {
      allow: true,
      reason: 'shell string allowed at this level — coarse scan only, not a real check',
      weak: true,
    };
  }

  const argv = argvField ?? [];
  if (argv.length === 0) return { allow: false, reason: 'empty command' };

  const name = commandName(argv[0]);

  // The banned list always wins, even if something else allows it.
  const banned = cfg.never.find((entry) => matchesNeverEntry(entry, argv));
  if (banned) {
    return {
      allow: false,
      reason: `"${banned}" is never allowed for the agent`,
    };
  }

  if (name === 'git' && argv.slice(1).some((a) => GIT_REPO_SELECTING.test(a))) {
    return {
      allow: false,
      reason: 'git may not be pointed at another repository, work tree or exec path',
    };
  }

  if (name === 'git' && argv.slice(1).some((a) => GIT_SHELLS_OUT.test(a))) {
    return {
      allow: false,
      reason:
        'git may not be given a flag that runs a command or sets arbitrary config (-x, --exec, -c, --config, --config-env)',
    };
  }

  if (name === 'git') {
    const sub = gitSubcommand(argv);
    if (sub !== null && GIT_LEAVES_THE_WORKTREE.has(sub)) {
      return {
        allow: false,
        reason:
          `"git ${sub}" names its source or destination as a plain argument, which no layer checks — ` +
          `it can read or write outside the ticket worktree`,
      };
    }
    // `git fetch ../other-repo` and `git submodule add <path> <path>` reach outside the same way, but
    // both have ordinary in-tree forms, so the ARGUMENT is judged rather than the subcommand.
    if (sub !== null && GIT_SUBS_WITH_PATH_ARGS.has(sub)) {
      const escaping = argv
        .slice(argv.indexOf(sub) + 1)
        .filter((a) => !a.startsWith('-'))
        .find(leavesTheTreeAsPath);
      if (escaping !== undefined) {
        return {
          allow: false,
          reason:
            `"git ${sub} ${escaping}" names a path outside this checkout, which no layer checks — ` +
            `it can read or write outside the ticket worktree ` +
            `(a remote name like "origin", or a real URL, is fine)`,
        };
      }
    }
  }

  // The search below takes the FIRST match, so two rules for one command
  // means one can never apply. Refuse it instead of guessing.
  if (cfg.allow.filter((r) => r.cmd === name).length > 1) {
    return {
      allow: false,
      reason: `the policy has more than one rule for "${name}" — only the first could ever apply, so this is refused rather than guessed`,
    };
  }

  const rule = cfg.allow.find((r) => r.cmd === name);
  if (!rule) {
    const decision = policy.onUnknownAction === 'deny';
    return {
      allow: !decision,
      reason: decision
        ? `"${name}" is not on the allow list`
        : `"${name}" is not on the allow list, but this level allows unknowns`,
    };
  }

  const badArg = rule.denyArgs?.find((bad) => matchesDenyArg(bad, argv));
  if (badArg) {
    return { allow: false, reason: `"${name}" may not be called with ${badArg}` };
  }

  if (rule.anyArgs) return { allow: true, reason: `"${name}" allowed with any arguments` };

  // The first argument that is not a flag must be an allowed subcommand.
  const sub = argv.slice(1).find((a) => !a.startsWith('-'));
  const allowedSubs = rule.subcommands ?? [];
  if (sub == null) {
    return { allow: true, reason: `"${name}" with no subcommand` };
  }
  if (!allowedSubs.includes(sub)) {
    return {
      allow: false,
      reason: `"${name} ${sub}" not allowed (allowed: ${allowedSubs.join(', ') || 'none'})`,
    };
  }
  return { allow: true, reason: `"${name} ${sub}" allowed` };
}

export function describe(policy: Policy): string[] {
  const cfg = policy.exec;
  if (!cfg.enabled) return ['off — any command may run'];

  const lines: string[] = [];
  lines.push(
    `shell strings: ${cfg.allowShellStrings ? 'ALLOWED — weak, see the file' : 'refused'}`,
  );
  lines.push(`  allowed commands (${cfg.allow.length}):`);
  for (const r of cfg.allow) {
    const args: string = r.anyArgs
      ? 'any args'
      : `subcommands: ${(r.subcommands ?? []).join(', ') || 'none'}`;
    const deny = r.denyArgs?.length ? `  never with: ${r.denyArgs.join(', ')}` : '';
    lines.push(`    ${r.cmd.padEnd(10)} ${args}${deny}`);
  }
  lines.push(`  never allowed (${cfg.never.length}): ${cfg.never.join(' · ')}`);
  return lines;
}
