import fs from 'node:fs';
import { backgroundStatus, killBackground } from '../../ticket/background.js';
import { runFiles } from '../../ticket/paths.js';
import { readTicket, activeCriteria, closeVerifyRound } from '../../ticket/ticketStore.js';
import { ROLES } from '../../types/ticket.js';
import { codeFor, codeChanges } from './codeState.js';
import { latestById, roundOutcome } from './outcome.js';
import type { Criterion } from '../../ticket/criteria.js';
import type { Ticket, Verification } from '../../types/ticket.js';

const ENDED_STATES = new Set(['finished', 'failed', 'crashed', 'cancelled']);

// How long a spawned round may wait for its verifier's pid file before it counts as never started.
export const VERIFIER_START_GRACE_MS = 60_000;

const openedLongAgo = (round: Verification): boolean =>
  !round.openedAt || Date.now() - Date.parse(round.openedAt) > VERIFIER_START_GRACE_MS;

// A run that started before this round opened is the last round's run, not this one's.
function runIsOlder(stateDir: string, id: string, round: Verification): boolean {
  const { startedAtPath } = runFiles(stateDir, id, ROLES.VERIFIER);
  if (!round.openedAt || !fs.existsSync(startedAtPath)) return false;
  return Number(fs.readFileSync(startedAtPath, 'utf8')) < Date.parse(round.openedAt);
}

// True once there is nothing left to wait for. A manual round ends when every AC has a result.
function roundEnded({
  stateDir,
  id,
  round,
  criteria,
  maxRuntimeMs,
}: {
  stateDir: string;
  id: string;
  round: Verification;
  criteria: Criterion[];
  maxRuntimeMs: number | null;
}): boolean {
  if (!round.spawned) {
    const latest = latestById(round.results);
    return criteria.every((c) => latest.has(c.id));
  }
  const status = backgroundStatus({ stateDir, id, role: ROLES.VERIFIER, maxRuntimeMs });
  if (status.state === 'timed-out') {
    // byUser:false — the time limit ended this, not a person.
    killBackground({ stateDir, id, role: ROLES.VERIFIER, byUser: false });
    return true;
  }
  // No verifier of this round yet: wait, unless it should have started long ago.
  const ended = ENDED_STATES.has(status.state);
  if (status.state === 'not-started' || (ended && runIsOlder(stateDir, id, round))) {
    return openedLongAgo(round);
  }
  return ended;
}

// Closes an open round whose verifier is done. True when this call closed it.
export function closeRoundIfEnded({
  stateDir,
  id,
  maxRuntimeMs = null,
}: {
  stateDir: string;
  id: string;
  maxRuntimeMs?: number | null;
}): boolean {
  const ticket = readTicket(stateDir, id);
  const round = ticket.verification;
  if (!round || round.outcome !== null || !ticket.worktree) return false;
  const criteria = activeCriteria(ticket);
  const now = codeFor(round, ticket.worktree);
  const changes = codeChanges(round, now);
  // A manual round has no process to wait for, so changed code ends it now.
  const manualChanged = !round.spawned && changes.length > 0;
  if (!manualChanged && !roundEnded({ stateDir, id, round, criteria, maxRuntimeMs })) return false;
  // Judged under the lock, from the results saved there: a result recorded since this read counts.
  const judge = (locked: Ticket) =>
    roundOutcome({
      criteria: activeCriteria(locked),
      results: locked.verification?.results ?? [],
      changes,
    });
  return closeVerifyRound(stateDir, id, { judge, tokenHash: round.token, code: now });
}
