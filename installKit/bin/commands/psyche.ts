import { appendEthosCandidate, CANDIDATE_SOURCE } from '../../../src/ticket/ticketStore.js';
import type { CandidateSource } from '../../../src/types/ticket.js';
import { loadCategories, flagsOf } from '../../../src/memory/categories.js';
import { hasTty } from '../cli/tty.js';
import { helpRequested, exitWithUsage } from '../cli/args.js';

export function runPsyche({
  args,
  stateDir,
  repoRoot,
  hasTty: hasTtyFn = hasTty,
}: {
  args: string[];
  stateDir: string;
  repoRoot: string;
  // Injectable so a test can prove the check fires without a real terminal.
  hasTty?: () => boolean;
}): void {
  // The flags come from the project's categories file.
  const flags = flagsOf(loadCategories(repoRoot));
  // This command builds its own usage, so it never reached assertKnownFlags.
  const usage = `usage: glafka psyche <ticket-id> ${Object.keys(flags).join('|')} "<text>"`;
  if (helpRequested(args)) exitWithUsage(usage);

  const id = args.find((arg) => !arg.startsWith('--'));
  if (!id) throw new Error(usage);

  // The first flag we find wins.
  let target: string | undefined;
  let text: string | undefined;
  for (const [flag, flagTarget] of Object.entries(flags)) {
    const idx = args.indexOf(flag);
    if (idx === -1) continue;
    target = flagTarget;
    // Stop at the next flag, so it is not read as text.
    const words = [];
    for (const word of args.slice(idx + 1)) {
      if (word.startsWith('--')) break;
      words.push(word);
    }
    text = words.join(' ');
    break;
  }
  if (!target) {
    throw new Error(
      `usage: glafka psyche <id> ${Object.keys(flags).join('|')} "<text>" [--from you]`,
    );
  }
  if (!text) {
    throw new Error(`glafka psyche ${id}: no rule text after the category flag`);
  }
  // ethosGate.ts renders "(you said)" on a --from you candidate — the label whose whole point is that it needs no second look, unlike an
  if (text.includes('\n')) {
    throw new Error(
      `glafka psyche ${id}: rule text may not contain a newline — one candidate is one line`,
    );
  }

  // `--from you` marks a rule a person made. Nothing before this checked that a person was the one typing it — an agent could claim it just as
  const fromIdx = args.indexOf('--from');
  const requestedFrom = fromIdx === -1 ? null : args[fromIdx + 1];
  if (requestedFrom === CANDIDATE_SOURCE.YOU && !hasTtyFn()) {
    throw new Error(
      `glafka psyche ${id}: --from you needs a real terminal attached — a script or agent ` +
        `cannot claim a rule came from a person. Run this yourself, interactively.`,
    );
  }
  // The value is checked when it is saved, so this cast is only here to
  // keep the compiler happy.
  const source = (requestedFrom ?? CANDIDATE_SOURCE.AGENT) as CandidateSource;

  const ethosCandidates = appendEthosCandidate(stateDir, id, { target, text, source });
  const pending = ethosCandidates.filter((candidate) => candidate.status === 'pending').length;
  console.log(`${id}  ${target} (${source}): ${text}`);
  console.log(`${pending} candidate(s) awaiting a decision on this ticket`);
  console.log(`you rule on them after review: glafka ergon ${id} --review --keep ...`);
}
