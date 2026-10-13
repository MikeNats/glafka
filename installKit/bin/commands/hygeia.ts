import { hygeia } from '../../../src/commands/hygeia/hygeia.js';
import { assertKnownFlags } from '../cli/args.js';

const HYGEIA_USAGE =
  'usage: glafka hygeia   npm only: semver-safe dependency updates plus an audit fix';

export function runHygeia({ args, repoRoot }: { args: string[]; repoRoot: string }): void {
  // It changes package files for real, so `--help` or anything unexpected must stop it first.
  assertKnownFlags(args, [], HYGEIA_USAGE);
  if (args.length > 0) throw new Error(`hygeia takes no arguments\n${HYGEIA_USAGE}`);
  const { updateLog, auditLog } = hygeia({ cwd: repoRoot });
  console.log(updateLog);
  console.log(auditLog);
}
