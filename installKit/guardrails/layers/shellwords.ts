// Splits a shell string into commands we can check.
// It refuses when unsure, because a wrong guess is worse than no guess.

// Things a shell EXPANDS. It expands them inside double quotes but not inside
// single quotes, so that is exactly where we look.
const EXPANDS = [
  { pattern: /\$\(/, why: 'command substitution $( ) hides a command' },
  { pattern: /`/, why: 'backtick substitution hides a command' },
  { pattern: /\$\{/, why: '${ } may expand into a command name' },
  // The plain $VAR form. A variable set earlier in the line can hold the real
  // command, and we would never see it.
  { pattern: /\$[A-Za-z_]/, why: 'a shell variable can expand into any command or flag' },
  { pattern: /<\(/, why: 'process substitution <( ) hides a command' },
];

// Words that give a hidden command away. We scan the raw string here,
// because even a quoted one is worth refusing.
const RAW_UNREADABLE = [
  { pattern: /(^|[^\w])eval([^\w]|$)/, why: 'eval runs a string built at runtime' },
  { pattern: /\bbase64\b\s+(-d|--decode)/, why: 'base64 -d hides its payload' },
  // ANSI-C quoting. bash turns the escapes inside $'...' into characters BEFORE deciding what the command is, so `$'\x67it' push` really runs
  { pattern: /\$'/, why: "ANSI-C quoting $'...' expands escapes into a command name" },
];

// Sending output to a file hides that path from the filesystem check. A `>` inside quotes is just text, so we only look outside quotes.
export const REDIRECTION_UNREADABLE =
  'redirection (< or >) reads or writes a file this tokenizer cannot see';
const REDIRECTION = {
  pattern: /[<>]/,
  why: REDIRECTION_UNREADABLE,
};

// Forms like `2>&1` join two output streams and name no file at all, so they are safe. We remove them first, or the `&` would look like a separator.
const FD_DUP = /^\d*[<>]&(?:\d+|-)/;
const FD_DUP_MAX_LEN = 12;

function stripFdDup(commandString: string): string {
  let out = '';
  let quote: string | null = null;
  const chars = Array.from(commandString);

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (quote) {
      out += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\\') {
      out += ch;
      if (i + 1 < chars.length) out += chars[++i];
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '<' || ch === '>' || /\d/.test(ch)) {
      const match = FD_DUP.exec(chars.slice(i, i + FD_DUP_MAX_LEN).join(''));
      // The window only bounds how far we scan for the pattern. Whether the match is really a whole token has to be checked against the FULL
      const next = match ? chars[i + match[0].length] : undefined;
      if (match && (next === undefined || /\s/.test(next))) {
        i += match[0].length - 1;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

// The command with quoted parts removed, so we only search where a shell
// would really act. It uses the same quote rules as tokenize() below.
function withoutQuoted(commandString: string, { keepDouble }: { keepDouble: boolean }): string {
  let out = '';
  let quote: string | null = null;
  const chars = Array.from(commandString);

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (quote === '"' && keepDouble) out += ch;
      continue;
    }
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    out += ch;
  }
  return out;
}

// Two-character separators are checked first,
// so a single & or | is not read as half of one.
const SEP_TWO = new Set(['&&', '||']);
// `(` and `)` are shell METACHARACTERS: unquoted, they always end a word, so `(git push)` runs git
// exactly as the bare form does. They used to be glued onto the word instead, which made the
// command name `(git` and skipped the whole never-list. `{` and `}` are
// deliberately NOT here. They are not metacharacters — `{` is a reserved WORD, so `{git push;}`
// runs a command literally called `{git` and there is nothing to leak, while `file{1,2}.txt` is
// brace expansion that splitting here would break.
const SEP_ONE = new Set([';', '\n', '|', '&', '(', ')']);

// Splits into commands and words. It tracks quotes, so a separator inside quotes is not read as a
// real command break. `dropped` carries the leading `VAR=value` assignments back out. They used to
// be discarded here and never seen again, which deleted the half of the line that decides what the
// command does — `GIT_DIR=…`, `GIT_SSH_COMMAND=…`, `PATH=…`. The caller decides
// which are harmless.
function tokenize(commandString: string): { segments: string[][]; dropped: string[] } {
  const segments: string[][] = [];
  const dropped: string[] = [];
  let segmentWords: string[] = [];
  let current = '';
  let started = false;
  let quote: string | null = null;
  const chars = Array.from(commandString);

  const endWord = () => {
    if (current || started) segmentWords.push(current);
    current = '';
    started = false;
  };
  const endSegment = () => {
    endWord();
    // Take leading VAR=value parts off, so we check the real command — but
    // hand them back rather than forget them.
    while (segmentWords.length > 1 && ENV_ASSIGNMENT.test(segmentWords[0])) {
      dropped.push(segmentWords.shift() as string);
    }
    if (segmentWords.length > 0) segments.push(segmentWords);
    segmentWords = [];
  };

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    // A backslash protects the next character, like in a real shell — EXCEPT a backslash-newline, which a real shell removes entirely as a
    if (ch === '\\') {
      if (i + 1 < chars.length) {
        if (chars[i + 1] === '\n') {
          i++;
          continue;
        }
        current += chars[++i];
        started = true;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    const two = ch + (chars[i + 1] ?? '');
    if (SEP_TWO.has(two)) {
      endSegment();
      i++;
      continue;
    }
    if (SEP_ONE.has(ch)) {
      endSegment();
      continue;
    }
    if (/\s/.test(ch)) {
      endWord();
      continue;
    }
    current += ch;
  }
  endSegment();

  return { segments, dropped };
}

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

// An environment prefix we refuse to read past, rather than a list of the bad ones. A deny list
// here is the same losing game as the never-list: `GIT_DIR`, `GIT_SSH_COMMAND`, `GIT_CONFIG_KEY_0`,
// `PATH`, `NODE_OPTIONS`, `LD_PRELOAD`, `DYLD_INSERT_LIBRARIES` are today's spellings and there is
// always one more. These are the assignments that cannot change WHICH binary runs or WHERE it
// points — they are values a program reads, nothing else.
const HARMLESS_ENV_PREFIX = new Set([
  'NODE_ENV',
  'CI',
  'DEBUG',
  'LOG_LEVEL',
  'TZ',
  'FORCE_COLOR',
  'NO_COLOR',
  'LANG',
  'LC_ALL',
  'TERM',
]);

export const ENV_PREFIX_UNREADABLE =
  'an environment assignment in front of the command can change what it does, or which binary runs';

function unsafeEnvPrefix(dropped: string[]): string | null {
  for (const assignment of dropped) {
    const name = assignment.slice(0, assignment.indexOf('='));
    if (!HARMLESS_ENV_PREFIX.has(name)) return name;
  }
  return null;
}

// What toArgvSegments gives back: either words we can check,
// or a reason we could not split it.
export type ArgvSegmentsResult =
  { segments: string[][]; unreadable?: undefined } | { segments?: undefined; unreadable: string };

export function toArgvSegments(commandString: string): ArgvSegmentsResult {
  for (const { pattern, why } of RAW_UNREADABLE) {
    if (pattern.test(commandString)) return { unreadable: why };
  }
  // Double quotes still expand. Single quotes never do.
  const expandable = withoutQuoted(commandString, { keepDouble: true });
  for (const { pattern, why } of EXPANDS) {
    if (pattern.test(expandable)) return { unreadable: why };
  }
  // Writing to a file only happens outside quotes,
  // and joining two streams is not writing to a file at all.
  const readable = stripFdDup(commandString);
  if (REDIRECTION.pattern.test(withoutQuoted(readable, { keepDouble: false }))) {
    return { unreadable: REDIRECTION.why };
  }

  const { segments, dropped } = tokenize(readable);

  // Checked before the segments are handed on, because the layers downstream
  // only ever see argv and there is no argv position these could occupy.
  const unsafe = unsafeEnvPrefix(dropped);
  if (unsafe !== null) {
    return { unreadable: `${ENV_PREFIX_UNREADABLE} (${unsafe}=…)` };
  }

  if (segments.length === 0) return { unreadable: 'nothing to check' };
  return { segments };
}
