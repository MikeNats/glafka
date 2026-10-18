import type { Ticket } from './contract';
import type { GlafkaTicket } from './schemas';

// The ticket waits for QA, and no agent can run it: glafka wants a person to check by hand.
export const NO_QA_AGENT = 'No QA agent is set: check the acceptance criteria by hand.';

// The criteria still to check: a person may skip some.
export function activeCriteria(g: GlafkaTicket) {
  const skipped = new Set((g.criteriaSkips ?? []).map((s) => s.id));
  return g.criteria.filter((c) => !skipped.has(c.id));
}

// glafka's own line, "<id>  ⚠ needs you  — <reason>": the reason, when it waits for you.
export function waitsOf(g: GlafkaTicket): string | null {
  const { rank, text } = g.summary;
  if (rank !== 0 || !text.includes('needs you')) return null;
  return text.split('—').slice(1).join('—').trim() || text;
}

const SKIP_REASON = 'could not be checked here';

// What glafka lets only a person do, at a terminal: skip a check QA could not do, or check by hand.
export function personSteps(
  g: GlafkaTicket,
  waits: string | null,
  bin: string,
): Ticket['personSteps'] {
  if (!waits) return [];
  if (waits === NO_QA_AGENT || /verify manually/.test(waits))
    return [{ label: 'Check it by hand', command: `${bin} ergon ${g.id} --review` }];
  const latest = new Map((g.qa?.results ?? []).map((r) => [r.id, r.result]));
  const active = new Set(activeCriteria(g).map((c) => c.id));
  const cannot = [...latest]
    .filter(([id, r]) => r === 'cannot' && active.has(id))
    .map(([id]) => id);
  if (cannot.length === 0) return [];
  const skip = (id: string) => `${bin} epalitheusis ${g.id} --skip ${id} --reason "${SKIP_REASON}"`;
  const label =
    cannot.length === 1
      ? `Skip ${cannot[0]} (QA could not check it)`
      : `Skip the ${cannot.length} checks QA could not do`;
  return [{ label, command: cannot.map(skip).join(' && ') }];
}
