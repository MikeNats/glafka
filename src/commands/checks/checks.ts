import { readTicket, assertNotClosed, saveCachedChecks } from '../../ticket/ticketStore.js';
import { runChecks, checksVerdict, CHECK_VERDICT } from '../../checks.js';
import { worktreeCheckKey, changedFiles } from '../../util/git.js';
import { resolvePolicy, hostExecBlocking } from '../../../installKit/guardrails/index.js';
import { assertNoLiveRun } from '../../ticket/background.js';
import { assertNoLiveVerifier } from '../../ticket/liveVerifier.js';
import type { Ticket } from '../../types/ticket.js';
import type { CheckResult, ChecksVerdict } from '../../types/checks.js';

// Run a ticket's checks on their own, and save the result where every other command already looks.
//
// This exists because of a trap the first ticket in any project is guaranteed to hit: `checksCmd`
// cannot be configured before a ticket exists, so the first coder runs with nothing to verify with,
// `epistle` correctly refuses to push unverified work — and every command its error named
// (`odysse --checks`, editing .glafka.json, `krisis`) configures or records something WITHOUT
// re-running the checks. The gate never moved. The only documented exit was `--unreviewed`, which
// stamps the ticket permanently even when every check passes by hand.
//
// The one command that did re-run them, `ergon --review`, spends a full review round — and
// `reviewRoundCount` charges that against `maxReviewRounds`. Paying an LLM to learn the exit code
// of `npm test` is the wrong price.
//
// So: no tokens, no reviewer, no review stage. It runs the commands and writes the results under
// the same cache key `ergon --review` uses, which is why `epistle` can then believe them.
export async function ticketChecks({
  stateDir,
  id,
  repoRoot,
  baseRef,
  checksCmd = null,
  e2eCmd = null,
  checksTimeoutMs = null,
  e2eTimeoutMs = null,
}: {
  stateDir: string;
  id: string;
  repoRoot: string;
  baseRef: string;
  checksCmd?: string | null;
  e2eCmd?: string | null;
  checksTimeoutMs?: number | null;
  e2eTimeoutMs?: number | null;
}): Promise<{ ticket: Ticket; checks: CheckResult[]; verdict: ChecksVerdict; saved: boolean }> {
  const ticket = readTicket(stateDir, id);
  assertNotClosed(ticket);
  if (!ticket.worktree) {
    throw new Error(`ticket ${id} has no worktree — there is nothing to run checks in`);
  }
  // The coder writes files while it works, so checks over a half-written tree
  // prove nothing about what it will end up committing.
  assertNoLiveRun({
    stateDir,
    id,
    action: 'running checks',
    risk: 'the coder is still editing, so a result now describes a tree that is about to change',
  });
  // Checks build and write files in the worktree the QA tester is testing.
  assertNoLiveVerifier({ stateDir, id, action: 'running checks' });

  // Same two guards `ergon --review` applies, and for the same reason: runChecks executes on the
  // host, outside every cage, so a branch that changed package.json or added a file that runs on
  // the host must not be executed unattended just because someone asked for a verdict.
  const { policy } = resolvePolicy({ repoRoot });
  const changed = changedFiles(ticket.worktree, baseRef);
  const checks = await runChecks(ticket.worktree, {
    checksCmd,
    e2eCmd,
    checksTimeoutMs,
    e2eTimeoutMs,
    untrustedPackageJson: changed.includes('package.json'),
    hostExecutingChanges: hostExecBlocking(policy, changed),
  });

  // A null key means the worktree has uncommitted edits, so the result cannot be tied to a commit.
  // saveCachedChecks already drops those; `saved` says so out loud, because an unsaved result will
  // not move epistle's gate and the caller has to be able to explain why.
  const key = worktreeCheckKey(ticket.worktree, { checksCmd, e2eCmd });
  saveCachedChecks(stateDir, id, key, checks);

  return { ticket, checks, verdict: checksVerdict(checks), saved: key !== null };
}

export { CHECK_VERDICT };
