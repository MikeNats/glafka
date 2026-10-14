import { createTicket } from '../../../src/commands/genesis/genesis.js';
import { describeTicket } from '../../../src/ticket/ticketStore.js';
import { warnGuardrailsNotReady } from '../agent/guardrailsReport.js';
import { helpRequested, exitWithUsage, flagValue } from '../cli/args.js';
import { printJson } from '../cli/json.js';
import type { Config } from '../../../src/types/config.js';

const CREATE_USAGE = [
  'usage: glafka create "<idea>" [--name "<words>"] [--json]',
  '',
  'Opens a ticket at the brainstorming stage and prints its id.',
  'No worktree, branch or port yet — those wait for plan.',
  '',
  'The id is the date plus a slug of the idea, so it reads as work.',
  '--name is for an idea with no letters a-z in it to slug.',
  '--json prints { contract, id, position } as JSON instead, for other tools.',
].join('\n');

// Opens a new ticket at the brainstorming stage.
// The worktree, branch and port are set up later, in plan.
export function runCreate({
  args,
  stateDir,
  repoRoot,
  config,
}: {
  args: string[];
  stateDir: string;
  repoRoot: string;
  config: Pick<Config, 'baseRef'>;
}): void {
  // The argument is free text, so `--help` only asks for help when it is the
  // whole of it. Inside a sentence it is what the ticket is about.
  if (helpRequested(args, { alone: true })) exitWithUsage(CREATE_USAGE);

  const name = flagValue(args, '--name', 'some words to name the ticket by');
  // The flag and its value are ours, not part of what the ticket is about.
  const idx = args.indexOf('--name');
  const named = name === null ? args : [...args.slice(0, idx), ...args.slice(idx + 2)];
  const json = named.includes('--json');
  const rest = named.filter((arg) => arg !== '--json');

  const ticket = createTicket({ stateDir, repoRoot, content: rest.join(' '), name });
  if (json) printJson({ id: ticket.id, position: describeTicket(ticket) });
  else console.log(`${ticket.id}  ${describeTicket(ticket)}`);
  // The first and cheapest moment to learn what the coder will be held to.
  // It prints on stderr, so JSON mode keeps stdout clean.
  warnGuardrailsNotReady({ repoRoot, baseRef: config.baseRef ?? 'main' });
}
