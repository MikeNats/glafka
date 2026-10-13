import { attachSpec } from '../../../src/commands/genesis/genesis.js';
import { describeTicket } from '../../../src/ticket/ticketStore.js';
import type { Config } from '../../../src/types/config.js';
import { flagValue, assertKnownFlags } from '../cli/args.js';
import { parseCriteria, strayCriteria, hasCriteriaSection } from '../../../src/ticket/criteria.js';

// Saves a spec file onto a ticket, with an optional short title. Every flag this command reads.
// Anything else is a typo, and a typo used to be silently ignored — sometimes into a different action entirely.
const SPEC_FLAGS = ['--title'];
const SPEC_USAGE = 'usage: glafka spec <ticket-id> <spec-file> [--title "<short title>"]';

export function runSpec({
  args,
  stateDir,
  repoRoot,
  config,
}: {
  args: string[];
  stateDir: string;
  repoRoot: string;
  config: Pick<Config, 'observability'>;
}): void {
  assertKnownFlags(args, SPEC_FLAGS, SPEC_USAGE);
  const title = flagValue(args, '--title');
  const titleIdx = args.indexOf('--title');
  const positional =
    titleIdx === -1 ? args : [...args.slice(0, titleIdx), ...args.slice(titleIdx + 2)];
  const [id, specPath] = positional;
  const ticket = attachSpec({
    stateDir,
    repoRoot,
    id,
    specPath,
    title,
    observability: config.observability.enabled,
  });
  console.log(`${ticket.id}  ${describeTicket(ticket)}`);

  const { criteria, badLines } = parseCriteria(ticket.specText);
  console.log(
    criteria.length === 0
      ? `  no acceptance criteria — epalitheusis will be skipped`
      : `  ${criteria.length} acceptance criteria — epalitheusis will check them`,
  );
  for (const line of badLines) {
    console.error(
      `  warning: not an AC line, ignored: ${line}  (expected "- AC-<n>: <start> → <action> → <result>")`,
    );
  }
  // AC lines glafka does not read: say so, or a criterion is off without a word.
  const stray = strayCriteria(ticket.specText);
  if (stray.length > 0) {
    const where = hasCriteriaSection(ticket.specText)
      ? 'sit outside the acceptance criteria section (after a heading that ends it)'
      : 'sit under no "## Acceptance criteria" heading';
    console.error(
      `  warning: ${stray.length} "- AC-<n>:" line(s) ${where}, so they are ignored:\n` +
        stray.map((line) => `    ${line}`).join('\n'),
    );
  }
}
