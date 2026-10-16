import fs from 'node:fs';
import path from 'node:path';
import { locateTicket, readStageLog } from './store.js';
import type { Ticket, Stage, StageLogEntry } from '../../types/ticket.js';

// --------------------------------------------------------------------------- The stage log

// Every command we ran, in order. The flow can go back and repeat.
// GENESIS is the old path that did spec, plan and setup in one go.
export const STAGES = Object.freeze({
  CREATE: 'create',
  SPEC: 'spec',
  GENESIS: 'genesis',
  PLAN: 'plan',
  ERGON: 'ergon',
  REVIEW: 'review',
  EPISTLE: 'epistle',
  LYSIS: 'lysis',
  CANCEL: 'cancel',
});

// The list of real stages. A Set, so a name like `constructor`
// can not sneak in as a stage.
const STAGE_VALUES = new Set(Object.values(STAGES));

// How the last ergon run ended.
export const RUN_OUTCOMES = Object.freeze({
  OK: 'ok',
  CHECKS_FAILED: 'checks-failed',
  // Not the same as OK. "No checks ran" must never look like a pass.
  CHECKS_UNKNOWN: 'checks-unknown',
  TIMED_OUT: 'timed-out',
  CRASHED: 'crashed',
  // Killed on purpose, by `killBackground`. Not a crash: nothing went wrong,
  // someone decided to stop it.
  CANCELLED: 'cancelled',
});

// The stage log for one ticket, wherever the ticket now lives.
export function readStageLogFor(stateDir: string, id: string): StageLogEntry[] {
  return readStageLog(locateTicket(stateDir, id).stagesFile);
}

// Adding to the end of a file is safe with two writers.
// We check the stage first, because a bad entry can never be undone.
// `qaBlocked` marks a round the QA round stopped: its criteria failed or could not be checked.
export function recordStage(
  stateDir: string,
  id: string,
  stage: Stage,
  note: string | null = null,
  { qaBlocked = false }: { qaBlocked?: boolean } = {},
): StageLogEntry[] {
  if (!STAGE_VALUES.has(stage)) {
    throw new Error(
      `refusing to record stage "${stage}" on ticket ${id} — ` +
        `expected one of ${[...STAGE_VALUES].join(', ')}. ` +
        `The stage log is append-only, so a wrong entry can never be taken back.`,
    );
  }
  const { stagesFile } = locateTicket(stateDir, id);
  fs.mkdirSync(path.dirname(stagesFile), { recursive: true });
  // The mark is written only when set, so every other entry stays exactly as it was.
  const entry = { at: new Date().toISOString(), stage, note, ...(qaBlocked ? { qaBlocked } : {}) };
  fs.appendFileSync(stagesFile, `${JSON.stringify(entry)}\n`);
  return readStageLog(stagesFile);
}

// The last stage that ran. Null if nothing has run yet.
export function currentStage(ticket: Ticket): Stage | null {
  const log = ticket.stageLog ?? [];
  return log.length === 0 ? null : log[log.length - 1].stage;
}

// Where the newest match sits in the log, or -1.
// Use this to compare order. Two stages can share the same timestamp.
export function lastStageIndex(ticket: Ticket, stage: Stage): number {
  const log = ticket.stageLog ?? [];
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i].stage === stage) return i;
  }
  return -1;
}

// Time of the newest match, or null. For display only.
export function lastStageAt(ticket: Ticket, stage: Stage): string | null {
  const index = lastStageIndex(ticket, stage);
  return index === -1 ? null : ticket.stageLog[index].at;
}
