import { TICKET_ID_RE } from '../../../src/ticket/ids.js';

// Reads `--flag <value>` from the arguments. Returns null when the flag is not
// there. `hint` says what a good value looks like, since that differs per flag.
export function flagValue(args: string[], flag: string, hint?: string): string | null {
  const idx = args.indexOf(flag);
  if (idx === -1) return null;
  const value = args[idx + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} needs a value${hint ? `: ${hint}` : ''}`);
  }
  return value;
}

const SELECTION_HINT = '"all", "none", or indices like "1,3"';

// Reads `--keep`, which takes "all", "none", or numbers like "1,3".
export const keepArg = (args: string[]): string | null => flagValue(args, '--keep', SELECTION_HINT);

// The same, but for `--kill`.
export const killArg = (args: string[]): string | null => flagValue(args, '--kill', SELECTION_HINT);

// Prints the command's own usage and stops, exit 0. Only the top-level `glafka --help` was ever
// handled; on a subcommand it fell through to the unknown-flag scan and came back as an error on exit 1.
export function exitWithUsage(usage: string): never {
  console.log(usage);
  process.exit(0);
}

// `alone` is for commands whose argument is free text — `create`, `heureka`. There `--help` is only a
// request for help when it is the whole argument; inside a longer sentence it is what the person is writing about.
export function helpRequested(
  args: string[],
  { alone = false }: { alone?: boolean } = {},
): boolean {
  if (alone) return args.length === 1 && (args[0] === '--help' || args[0] === '-h');
  return args.includes('--help') || args.includes('-h');
}

// Refuses a flag the command does not know. Commands here dispatch on `args.includes('--x')` and
// fall through to a default when none match. For `ergon` that default is a real mode — it prints
// the coder prompt and marks a run as started — so `--stats` for `--status` silently gave the
// ticket a coder that does not exist, and every later command had to warn its way past it.
// One typo, one wedged ticket, and nothing said a word. `known` is the full
// list the command reads. Anything else, including a near-miss, stops the command before it changes
// anything.
export function assertKnownFlags(args: string[], known: string[], usage: string): void {
  // Asking for help is not a typo.
  if (helpRequested(args)) exitWithUsage(usage);

  const allowed = new Set(known);
  const unknown = args.filter((arg) => arg.startsWith('--') && !allowed.has(arg));
  if (unknown.length === 0) return;

  // Name the closest real flag when there is an obvious one. A typo is far more common here than a
  // flag someone invented, and the two that matter most — `--stats` for `--status`, `--reveiw` for
  // `--review` — are a deletion and a transposition, neither of which a prefix test catches.
  const distance = (a: string, b: string): number => {
    let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const row = [i];
      for (let j = 1; j <= b.length; j++) {
        row[j] = Math.min(
          previous[j]! + 1,
          row[j - 1]! + 1,
          previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
        );
      }
      previous = row;
    }
    return previous[b.length]!;
  };

  const near = (bad: string): string | null => {
    const stripped = bad.replace(/^--/, '');
    let best: { flag: string; score: number } | null = null;
    for (const candidate of known) {
      const other = candidate.replace(/^--/, '');
      // Two edits, or one string being the start of the other. Beyond that a
      // guess is noise, and a wrong guess is worse than none.
      const score =
        other.startsWith(stripped) || stripped.startsWith(other) ? 0 : distance(stripped, other);
      if (score > 2) continue;
      if (!best || score < best.score) best = { flag: candidate, score };
    }
    return best?.flag ?? null;
  };

  const lines = unknown.map((bad) => {
    const suggestion = near(bad);
    return `  ${bad}${suggestion ? `  — did you mean ${suggestion}?` : ''}`;
  });
  throw new Error(
    `unknown flag${unknown.length > 1 ? 's' : ''}:\n${lines.join('\n')}\n\n${usage}\n` +
      `nothing was changed.`,
  );
}

// Finds the ticket id. It first looks for a word shaped like an id, so flag order does not matter, then falls back to the first plain word.
export function positionalId(
  args: string[],
  { single = [], spread = [] }: { single?: string[]; spread?: string[] } = {},
): string | undefined {
  const shaped = args.find((arg) => TICKET_ID_RE.test(arg));
  if (shaped) return shaped;

  const consumed = new Set<string>();
  for (const flag of single) {
    const idx = args.indexOf(flag);
    if (idx !== -1 && args[idx + 1] !== undefined) consumed.add(args[idx + 1]);
  }
  for (const flag of spread) {
    const idx = args.indexOf(flag);
    if (idx === -1) continue;
    for (const value of args.slice(idx + 1)) {
      if (value.startsWith('--')) break;
      consumed.add(value);
    }
  }
  return args.find((arg) => !arg.startsWith('--') && !consumed.has(arg));
}
