// The usual ways a command line names one program: by name, by a path, after env or xargs.
// Claude matches a rule as text, so each way needs its own rule.
export const headsOf = (program: string): string[] => [
  program,
  `*/${program}`,
  `env *${program}`,
  `xargs *${program}`,
];

// One Bash rule per head, each followed by the same rest.
export const spellings = (heads: string[], rest: string): string[] =>
  heads.map((head) => `Bash(${rest === '' ? head : `${head} ${rest}`})`);
