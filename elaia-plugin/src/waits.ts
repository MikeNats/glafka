import type { Stage, Ticket } from './contract';
import type { GlafkaTicket } from './schemas';

// The ticket waits for QA, and no agent can run it: glafka wants a person to check by hand.
export const NO_QA_AGENT = 'No QA agent is set: check the acceptance criteria by hand.';
// A person ran `glafka ergon <id> --review` with no QA agent: the round waits for their results.
const BY_HAND = 'A check by hand is open';

// The criteria still to check: a person may skip some.
export function activeCriteria(g: GlafkaTicket) {
  const skipped = new Set((g.criteriaSkips ?? []).map((s) => s.id));
  return g.criteria.filter((c) => !skipped.has(c.id));
}

// The criteria let this code be pushed. glafka's qaGap is epistle's own check. An older glafka
// has none: then QA must have passed in a round opened after the last coder run.
export function qaDoneOf(g: GlafkaTicket, qa: Ticket['qa']): boolean {
  if (g.qaGap !== undefined) return g.qaGap === null;
  if (activeCriteria(g).length === 0) return true;
  if (qa.state !== 'passed') return false;
  const opened = g.qa?.openedAt;
  const lastCoder = g.stages
    .flatMap((s) => (s.stage === 'ergon' ? [s.at] : []))
    .sort()
    .at(-1);
  return !opened || !lastCoder || opened >= lastCoder;
}

// glafka's own line, "<id>  ⚠ needs you  — <reason>": the reason, when it waits for you.
export function waitsOf(g: GlafkaTicket): string | null {
  const { rank, text } = g.summary;
  if (rank !== 0 || !text.includes('needs you')) return null;
  return text.split('—').slice(1).join('—').trim() || text;
}

// glafka closes the round once every criterion has a result.
function byHandReason(g: GlafkaTicket): string {
  const recorded = new Set((g.qa?.results ?? []).map((r) => r.id));
  const missing = activeCriteria(g).flatMap((c) => (recorded.has(c.id) ? [] : [c.id]));
  return missing.length > 0
    ? `${BY_HAND}: record a result for ${missing.join(', ')} with the commands it printed in your terminal.`
    : `${BY_HAND}, and every criterion has a result: press Next step to finish it.`;
}

export interface QaFacts {
  stage: Stage;
  working: boolean;
  byHand: boolean;
  hasVerifier: boolean;
  qa: Ticket['qa'];
}

// Why QA waits for you when glafka's own line does not say: a check by hand is open, no QA
// agent is set, or QA passed on other code (glafka will not push on that pass).
export function qaWaits(g: GlafkaTicket, t: QaFacts): string | null {
  if (t.stage !== 'testing' || t.working) return null;
  if (t.byHand) return byHandReason(g);
  if (!t.hasVerifier) return NO_QA_AGENT;
  if (t.qa.state === 'passed' && g.qaGap)
    return `QA passed, but not on this code: ${g.qaGap}. Press Next step to check it again.`;
  return null;
}

// A word as a shell reads it: quoted when it holds a space or a shell character.
const shellWord = (word: string) =>
  /^[\w./:@%+=,-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;

const SKIP_REASON = 'could not be checked here';

// What glafka lets only a person do, at a terminal: skip a check QA could not do, or check by hand.
export function personSteps(
  g: GlafkaTicket,
  waits: string | null,
  bin: string,
): Ticket['personSteps'] {
  if (!waits) return [];
  const glafka = shellWord(bin);
  // At a terminal it opens a new round, with a new token, and prints how to record each result.
  const review = `${glafka} ergon ${g.id} --review`;
  if (waits.startsWith(BY_HAND))
    return [{ label: 'Start the check by hand again', command: review }];
  if (waits === NO_QA_AGENT || /verify manually/.test(waits))
    return [{ label: 'Check it by hand', command: review }];
  const latest = new Map((g.qa?.results ?? []).map((r) => [r.id, r.result]));
  const active = new Set(activeCriteria(g).map((c) => c.id));
  const cannot = [...latest]
    .filter(([id, r]) => r === 'cannot' && active.has(id))
    .map(([id]) => id);
  if (cannot.length === 0) return [];
  const skip = (id: string) =>
    `${glafka} epalitheusis ${g.id} --skip ${id} --reason "${SKIP_REASON}"`;
  const label =
    cannot.length === 1
      ? `Skip ${cannot[0]} (QA could not check it)`
      : `Skip the ${cannot.length} checks QA could not do`;
  return [{ label, command: cannot.map(skip).join(' && ') }];
}
