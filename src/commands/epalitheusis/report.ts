import {
  activeCriteria,
  roundOwnsAporia,
  VERIFY_OUTCOME,
  VERIFY_RESULT,
} from '../../ticket/ticketStore.js';
import { latestById } from './outcome.js';
import type { Ticket } from '../../types/ticket.js';

// The verify block that `ergon --review --status` and `epalitheusis --status` print.
export function formatVerifyBlock(ticket: Ticket, runState: string): string[] {
  const round = ticket.verification;
  if (!round)
    return [
      `${ticket.id}  no verification round yet — glafka ergon ${ticket.id} --review starts one`,
    ];
  const latest = latestById(round.results);
  const lines = [
    `${ticket.id}  verify run=${round.spawned ? runState : 'none (manual)'}  outcome=${round.outcome ?? 'open'}`,
  ];
  for (const criterion of activeCriteria(ticket)) {
    const result = latest.get(criterion.id);
    const mark = !result
      ? 'not checked'
      : result.result === VERIFY_RESULT.PASS && !result.verified
        ? 'pass (not trusted — no round token)'
        : result.result;
    lines.push(`  ${criterion.id}  [${mark}]  ${criterion.text}`);
    if (result) lines.push(`        evidence: ${result.evidence}`);
  }
  for (const skip of ticket.criteriaSkips ?? []) {
    lines.push(`  ${skip.id}  [skipped by a person]  ${skip.reason}`);
  }
  if (round.outcome && round.outcome !== VERIFY_OUTCOME.PASSED) {
    lines.push(`  ${round.outcome}: ${round.detail ?? ''}`);
  }
  if (roundOwnsAporia(ticket)) lines.push(`  ⚠ ATTENTION NEEDED — ${ticket.aporia?.reason}`);
  return lines;
}
