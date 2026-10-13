import { appendDecision, DECISION_SOURCE } from '../../../src/ticket/decisions.js';
import { hasTty } from '../cli/tty.js';
import { helpRequested, exitWithUsage, positionalId } from '../cli/args.js';

const USAGE = 'usage: glafka apofasi <ticket-id> "<what was decided>"';

export function runApofasi({
  args,
  stateDir,
  hasTty: hasTtyFn = hasTty,
}: {
  args: string[];
  stateDir: string;
  // Injectable so a test can prove the section is chosen without a terminal.
  hasTty?: () => boolean;
}): void {
  if (helpRequested(args)) exitWithUsage(USAGE);

  const id = positionalId(args);
  if (!id) throw new Error(USAGE);

  const text = args
    .filter((arg) => arg !== id && !arg.startsWith('--'))
    .join(' ')
    .trim();
  if (text === '') throw new Error(USAGE);

  // Who is typing decides the section. No flag, because a flag an agent can
  // set is not gravity — psyche learned this with --from you.
  const source = hasTtyFn() ? DECISION_SOURCE.PERSON : DECISION_SOURCE.CODER;
  appendDecision(stateDir, id, { source, text });

  console.log(`${id}  ${source}: ${text}`);
}
