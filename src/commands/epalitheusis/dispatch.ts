import fs from 'node:fs';
import { withFileLock } from '../../util/fileOperations.js';
import { runFiles } from '../../ticket/paths.js';
import { spawnBackground } from '../../ticket/background.js';
import { assertNoLiveVerifier } from '../../ticket/liveVerifier.js';
import {
  openVerifyRound,
  closeVerifyRound,
  hashReviewToken,
  clearNotified,
  VERIFY_OUTCOME,
} from '../../ticket/ticketStore.js';
import type { VerifyPrepared } from './prompts.js';
import { codeState, withoutCheckMade } from './codeState.js';
import { ROLES } from '../../types/ticket.js';
import type { Policy } from '../../../installKit/guardrails/index.js';
import type { Ticket } from '../../types/ticket.js';

// Runs `fn` under the verifier's run lock, once no QA tester is live.
function underVerifierLock<T>(stateDir: string, id: string, risk: string, fn: () => T): T {
  const { dir, lockPath } = runFiles(stateDir, id, ROLES.VERIFIER);
  fs.mkdirSync(dir, { recursive: true });
  return withFileLock(lockPath, () => {
    assertNoLiveVerifier({ stateDir, id, action: 'verifying', risk });
    return fn();
  });
}

// Opens the round and starts the verifier as one step, under the verifier's run lock.
export function dispatchVerifier({
  stateDir,
  ticket,
  verify,
  agentCmd,
  policy = null,
}: {
  stateDir: string;
  ticket: Pick<Ticket, 'id' | 'worktree'>;
  verify: VerifyPrepared;
  agentCmd: string;
  policy?: Policy | null;
}): ReturnType<typeof spawnBackground> {
  const worktree = ticket.worktree;
  if (!worktree) throw new Error(`ticket ${ticket.id} has no worktree — nothing to verify`);
  const risk = 'a second QA tester would throw away the results of the first';
  return underVerifierLock(stateDir, ticket.id, risk, () => {
    openVerifyRound(stateDir, ticket.id, {
      token: verify.token,
      ...withoutCheckMade(codeState(worktree), verify.checkMade),
      checkMade: verify.checkMade,
      spawned: true,
    });
    // The round is real now, so the "a person was told" mark goes. The clean review it
    // follows stays: it is the verdict on this same code.
    clearNotified(stateDir, ticket.id);
    // Closes this round only: its token names it.
    const notStarted = (why: string): Error => {
      closeVerifyRound(stateDir, ticket.id, {
        outcome: VERIFY_OUTCOME.INCOMPLETE,
        detail: `the verifier did not start: ${why}`,
        tokenHash: hashReviewToken(verify.token),
      });
      return new Error(`ticket ${ticket.id}: the verifier did not start: ${why}`);
    };
    let run: ReturnType<typeof spawnBackground>;
    try {
      run = spawnBackground({
        stateDir,
        id: ticket.id,
        role: ROLES.VERIFIER,
        agentCmd,
        prompt: verify.verifierPrompt,
        cwd: worktree,
        policy,
      });
    } catch (err) {
      notStarted((err as Error).message);
      throw err;
    }
    // No pid means no process to wait for, and the round would stay open for good.
    if (run.pid === undefined) throw notStarted(`no process id (see ${run.logPath})`);
    return run;
  });
}

// No verifier agent configured: a person runs the brief, so there is no process to wait on.
// It replaces an open manual round, so it takes the same lock as dispatchVerifier.
export function openManualRound({
  stateDir,
  ticket,
  verify,
}: {
  stateDir: string;
  ticket: Pick<Ticket, 'id' | 'worktree'>;
  verify: VerifyPrepared;
}): void {
  const worktree = ticket.worktree;
  if (!worktree) throw new Error(`ticket ${ticket.id} has no worktree — nothing to verify`);
  const risk = 'a manual round now would throw away the results of the QA tester';
  underVerifierLock(stateDir, ticket.id, risk, () => {
    openVerifyRound(stateDir, ticket.id, {
      token: verify.token,
      ...withoutCheckMade(codeState(worktree), verify.checkMade),
      checkMade: verify.checkMade,
      spawned: false,
    });
    clearNotified(stateDir, ticket.id);
  });
}
