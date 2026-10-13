import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeGitRepo, addBareRemote } from '../helpers/gitFixture.js';
import { genesis } from '../../src/commands/genesis/genesis.js';
import { epistle, epistlePrepare } from '../../src/commands/epistle/epistle.js';
import { PullRequestFailedError } from '../../src/util/git.js';
import { ergonBackground, ergonReview, dispatchReviewer } from '../../src/commands/ergon/ergon.js';
import { backgroundStatus } from '../../src/ticket/background.js';
import { verifyGate, codeState } from '../../src/commands/epalitheusis/epalitheusis.js';
import { lysis } from '../../src/commands/lysis/lysis.js';
import { runFiles } from '../../src/ticket/paths.js';
import { makeTempDir } from '../helpers/tempDir.js';
import {
  readTicket,
  writeTicket,
  hasOpenPr,
  recordStage,
  appendReviewFinding,
  setReviewToken,
  openVerifyRound,
  appendVerifyResult,
  closeVerifyRound,
  hashReviewToken,
  STAGES,
  RUN_OUTCOMES,
  REVIEW_VERDICT,
} from '../../src/ticket/ticketStore.js';

function tempStateDir() {
  return makeTempDir('state');
}

// 60s, not 20s. These wait on a real spawned process, and a full `npm test` saturates the machine, so
// a cold process can take well past 20s to be scheduled. The assertions are about ordering, not speed.
function waitFor(
  predicate: () => boolean,
  { timeoutMs = 60000, intervalMs = 20 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('timed out waiting'));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

// Sets up a ticket ready to push. Real repo, fake remote.
// Many tests below reuse this setup.
async function pushableTicket({ planContent }: { planContent?: string } = {}) {
  const repoRoot = makeGitRepo();
  addBareRemote(repoRoot);
  const stateDir = tempStateDir();
  const ticket = await genesis({ repoRoot, stateDir, content: 'ship this', planContent });
  return { repoRoot, stateDir, ticket };
}

test(
  'epistle pushes the branch for real and records the PR url from the injected opener',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const remoteDir = addBareRemote(repoRoot);
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'ship this\nmore detail' });

    let receivedArgs: { cwd: string; title: string; body: string; base?: string } | null = null;
    const fakeCreatePr = (args: { cwd: string; title: string; body: string; base?: string }) => {
      receivedArgs = args;
      return 'https://github.com/example/repo/pull/1';
    };

    const result = await epistle({
      stateDir,
      unreviewed: true,
      id: ticket.id,
      repoRoot,
      createPr: fakeCreatePr,
    });

    // Check the push really worked on the fake remote.
    const branchesOnRemote = execFileSync('git', ['branch', '--list', ticket.branch!], {
      cwd: remoteDir,
      encoding: 'utf8',
    });
    assert.equal(branchesOnRemote.trim(), ticket.branch!);

    assert.equal(receivedArgs!.title, 'ship this');
    // This push used `--unreviewed`, so the body carries the banner and then the
    // ticket. The banner's own content is asserted in its own test below.
    assert.match(receivedArgs!.body, /--unreviewed/);
    assert.ok(receivedArgs!.body.endsWith('ship this\nmore detail'));
    assert.equal(receivedArgs!.base, 'main');

    assert.equal(hasOpenPr(result.ticket), true);
    assert.equal(result.ticket.prUrl, 'https://github.com/example/repo/pull/1');
    assert.equal(readTicket(stateDir, ticket.id).prUrl, 'https://github.com/example/repo/pull/1');
  },
);

test(
  'epistle has no doc-sync prompt when the ticket has no plan',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    addBareRemote(repoRoot);
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'no plan here' });

    const result = await epistle({
      // Review checks are tested elsewhere. Not needed here.
      unreviewed: true,
      stateDir,
      id: ticket.id,
      repoRoot,
      createPr: () => 'https://github.com/example/repo/pull/2',
    });

    assert.equal(result.docSyncPrompt, null);
  },
);

test(
  'epistle builds a doc-sync prompt from the plan and the final diff when a plan exists',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    addBareRemote(repoRoot);
    const stateDir = tempStateDir();
    const ticket = await genesis({
      repoRoot,
      stateDir,
      content: 'ship this',
      planContent: '1. add the feature',
    });

    execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'feature work'], {
      cwd: ticket.worktree!,
    });

    const result = await epistle({
      // Review checks are tested elsewhere. Not needed here.
      unreviewed: true,
      stateDir,
      id: ticket.id,
      repoRoot,
      createPr: () => 'https://github.com/example/repo/pull/3',
    });

    // Paths, not contents: the agent opens the plan itself, because editing it in place is the job.
    // Which copy each path names is `inWorktree`'s business and is tested with it.
    assert.match(result.docSyncPrompt!, /The plan, and the file you edit: .*plan\.md/);
    assert.match(result.docSyncPrompt!, /read-only: .*spec\.md/);
    assert.doesNotMatch(result.docSyncPrompt!, /1\. add the feature/);
    assert.match(result.docSyncPrompt!, /Result/);
    // No PR is named: the prompt is built BEFORE the push now, so the edit can
    // be committed onto the branch and travel with the pull request.
    assert.doesNotMatch(result.docSyncPrompt!, /pull\/3/);
    assert.match(result.docSyncPrompt!, /about to be pushed/);
    assert.match(result.docSyncPrompt!, /docs\/glafka\/tickets\/.*\/plan\.md/);
  },
);

test(
  'epistle always builds an odysse-update prompt scoped to what the ticket actually changed',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    addBareRemote(repoRoot);
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'add a widget' });

    fs.writeFileSync(path.join(ticket.worktree!, 'widget.js'), 'export const widget = 1;\n');
    execFileSync('git', ['add', 'widget.js'], { cwd: ticket.worktree! });
    execFileSync('git', ['commit', '-q', '-m', 'add widget.js'], { cwd: ticket.worktree! });

    const result = await epistle({
      // Review checks are tested elsewhere. Not needed here.
      unreviewed: true,
      stateDir,
      id: ticket.id,
      repoRoot,
      createPr: () => 'https://github.com/example/repo/pull/4',
    });

    assert.match(result.odysseUpdatePrompt, /widget\.js/);
    // The BRANCH's docs, not the main checkout's. The agent writes there and
    // the tidy commit puts the result in the pull request.
    assert.ok(
      result.odysseUpdatePrompt.includes(`${ticket.worktree!}/docs/glafka/architecture`),
      'the architecture docs to write are the ones on this branch',
    );
    assert.ok(!result.odysseUpdatePrompt.includes(`${repoRoot}/docs/glafka/architecture`));
  },
);

test(
  'epistle rebases onto the latest origin/main before pushing, bringing in work that landed after the ticket branched',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const remoteDir = addBareRemote(repoRoot);
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'ship this' });

    execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'ticket work'], {
      cwd: ticket.worktree!,
    });

    // Someone else adds work to main while the ticket is open.
    fs.writeFileSync(path.join(repoRoot, 'other-work.txt'), "someone else's work\n");
    execFileSync('git', ['add', 'other-work.txt'], { cwd: repoRoot });
    execFileSync('git', ['commit', '-q', '-m', 'other work'], { cwd: repoRoot });
    execFileSync('git', ['push', 'origin', 'main'], { cwd: repoRoot });

    await epistle({
      stateDir,
      unreviewed: true,
      id: ticket.id,
      repoRoot,
      createPr: () => 'https://example/pull/5',
    });

    // The remote branch must have that other work.
    // This proves rebase ran before push.
    const tmpClone = makeTempDir('clone');
    execFileSync('git', ['clone', '-q', '--branch', ticket.branch!, remoteDir, tmpClone]);
    assert.equal(fs.existsSync(path.join(tmpClone, 'other-work.txt')), true);
  },
);

test(
  'epistle refuses to push a branch that tracks .env.glafka',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    addBareRemote(repoRoot);
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });
    // Force-add the ignored file, like someone did by mistake.
    execFileSync('git', ['add', '-f', '.env.glafka'], { cwd: ticket.worktree! });
    execFileSync('git', ['commit', '-q', '-m', 'oops, committed the env file'], {
      cwd: ticket.worktree!,
    });

    await assert.rejects(
      () =>
        epistle({ stateDir, unreviewed: true, id: ticket.id, repoRoot, createPr: () => 'unused' }),
      /\.env\.glafka is tracked/,
    );
    assert.equal(hasOpenPr(readTicket(stateDir, ticket.id)), false);
  },
);

test(
  'epistle refuses while a background ergon run is still going',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    addBareRemote(repoRoot);
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'task', planContent: '1. do it' });
    const { pid } = await ergonBackground({
      stateDir,
      id: ticket.id,
      repoRoot,
      agentCmd: 'sleep 30',
    });

    await assert.rejects(
      () =>
        epistle({ stateDir, unreviewed: true, id: ticket.id, repoRoot, createPr: () => 'unused' }),
      /background ergon run still/,
    );

    process.kill(pid!, 'SIGKILL');
    return waitFor(() => {
      try {
        process.kill(pid!, 0);
        return false;
      } catch {
        return true;
      }
    });
  },
);

test('epistle refuses when the last run ended badly', { concurrency: true }, async () => {
  const repoRoot = makeGitRepo();
  addBareRemote(repoRoot);
  const stateDir = tempStateDir();
  const ticket = await genesis({ repoRoot, stateDir, content: 'task' });
  // There is no "failed" field to set, so we record a crashed run.
  recordStage(stateDir, ticket.id, STAGES.ERGON, RUN_OUTCOMES.CRASHED);

  await assert.rejects(
    () =>
      epistle({ stateDir, unreviewed: true, id: ticket.id, repoRoot, createPr: () => 'unused' }),
    /the last ergon run ended/,
  );
});

// A crashed run must still block push, even if a PR is open.
test(
  'a bad last run blocks the push even with a PR already open',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    addBareRemote(repoRoot);
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });
    writeTicket(stateDir, { ...ticket, prUrl: 'https://github.com/x/y/pull/1' });
    recordStage(stateDir, ticket.id, STAGES.ERGON, RUN_OUTCOMES.CRASHED);

    await assert.rejects(
      () =>
        epistle({ stateDir, unreviewed: true, id: ticket.id, repoRoot, createPr: () => 'unused' }),
      /the last ergon run ended/,
    );
  },
);

// A closed ticket must show "closed", not "crashed run".
// Its files are gone, so "fix the run" makes no sense.
test(
  'epistle refuses a closed ticket as closed, not as needing attention',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    addBareRemote(repoRoot);
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });
    recordStage(stateDir, ticket.id, STAGES.ERGON, RUN_OUTCOMES.CRASHED);
    // Close it for real, so the files are actually gone.
    await lysis({ repoRoot, stateDir, id: ticket.id });

    await assert.rejects(
      () =>
        epistle({ stateDir, unreviewed: true, id: ticket.id, repoRoot, createPr: () => 'unused' }),
      (err: Error) => {
        assert.match(err.message, /is already closed/);
        assert.doesNotMatch(err.message, /the last ergon run ended/, 'names the wrong cause');
        return true;
      },
    );
  },
);

// If a run is both "still running" and "marked bad", show
// the "still running" warning. That one is safer to act on.
test(
  'a live run outranks a bad last run in what epistle refuses with',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    addBareRemote(repoRoot);
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'task', planContent: '1. do it' });
    const { pid } = await ergonBackground({
      stateDir,
      id: ticket.id,
      repoRoot,
      agentCmd: 'sleep 30',
    });
    recordStage(stateDir, ticket.id, STAGES.ERGON, RUN_OUTCOMES.TIMED_OUT);

    await assert.rejects(
      () =>
        epistle({ stateDir, unreviewed: true, id: ticket.id, repoRoot, createPr: () => 'unused' }),
      (err: Error) => {
        assert.match(err.message, /background ergon run still/);
        assert.doesNotMatch(
          err.message,
          /the last ergon run ended/,
          'the live run is the urgent fact',
        );
        return true;
      },
    );

    process.kill(pid!, 'SIGKILL');
    return waitFor(() => {
      try {
        process.kill(pid!, 0);
        return false;
      } catch {
        return true;
      }
    });
  },
);

// Push must be blocked if the ticket was never reviewed.
test(
  'epistle refuses to push a ticket that was never reviewed',
  { concurrency: true },
  async () => {
    const { repoRoot, stateDir, ticket } = await pushableTicket();
    recordStage(stateDir, ticket.id, STAGES.ERGON);

    await assert.rejects(
      () => epistle({ stateDir, id: ticket.id, repoRoot, createPr: () => 'unused' }),
      (err: Error) => {
        assert.match(err.message, /has never been reviewed/);
        assert.match(err.message, /glafka ergon .* --review/);
        assert.match(err.message, /--unreviewed/);
        return true;
      },
    );
    assert.equal(readTicket(stateDir, ticket.id).prUrl, null);
    assert.equal(hasOpenPr(readTicket(stateDir, ticket.id)), false);
  },
);

// One review is not enough if the code changed again after.
test(
  'epistle refuses when the code changed after the last review',
  { concurrency: true },
  async () => {
    const { repoRoot, stateDir, ticket } = await pushableTicket();
    recordStage(stateDir, ticket.id, STAGES.ERGON);
    recordStage(stateDir, ticket.id, STAGES.REVIEW);
    recordStage(stateDir, ticket.id, STAGES.ERGON);

    await assert.rejects(
      () => epistle({ stateDir, id: ticket.id, repoRoot, createPr: () => 'unused' }),
      /older than the last code change/,
    );
  },
);

// A REVIEW entry alone just means a review started. A real finding is what makes it actually reviewed
// — and, on the foreground path (no separate reviewer configured, so backgroundStatus never advances past not-started), only a finding recorded with THIS round's real token counts as that. See below for what happens without one.
test(
  'epistle pushes once the ticket has been reviewed since the last change, with a real token',
  { concurrency: true },
  async () => {
    const { repoRoot, stateDir, ticket } = await pushableTicket();
    recordStage(stateDir, ticket.id, STAGES.ERGON);
    recordStage(stateDir, ticket.id, STAGES.REVIEW);
    setReviewToken(stateDir, ticket.id, 'a-real-round-token');
    appendReviewFinding(stateDir, ticket.id, {
      verdict: REVIEW_VERDICT.CLEAN,
      token: 'a-real-round-token',
    });

    const result = await epistle({
      stateDir,
      id: ticket.id,
      repoRoot,
      createPr: () => 'https://example/pull/9',
    });

    assert.equal(result.ticket.prUrl, 'https://example/pull/9');
    const log = readTicket(stateDir, ticket.id).stageLog;
    assert.equal(log[log.length - 1].stage, 'epistle');
    assert.equal(log[log.length - 1].note, null, 'a reviewed push must not be marked unreviewed');
  },
);

// Before this fix, a `clean` verdict recorded with NO token at all was stamped
// `verified: true` whenever the ticket had never started a review round (reviewToken null). Since `glafka krisis` is allow-listed for the coder itself at levels 3 and 4, that let a coder self-certify its own diff as reviewed-clean, with no reviewer process ever having run, and push it.
test(
  'epistle refuses a self-certified clean verdict with no token — no review round ever ran',
  { concurrency: true },
  async () => {
    const { repoRoot, stateDir, ticket } = await pushableTicket();
    recordStage(stateDir, ticket.id, STAGES.ERGON);
    recordStage(stateDir, ticket.id, STAGES.REVIEW);
    // No setReviewToken call — this ticket never had a review round prepared.
    const recorded = appendReviewFinding(stateDir, ticket.id, { verdict: REVIEW_VERDICT.CLEAN });
    assert.equal(recorded[0].verified, false, 'an unrounded clean verdict must not be verified');

    await assert.rejects(
      () => epistle({ stateDir, id: ticket.id, repoRoot, createPr: () => 'unused' }),
      /no reviewer has actually looked at this diff/,
    );
    assert.equal(readTicket(stateDir, ticket.id).prUrl, null);
  },
);

// Same shape, but the coder also guesses at a token instead of leaving it
// out. Guessing must not work either.
test(
  'epistle refuses a clean verdict whose token does not match this round, even with a REVIEW stage recorded',
  { concurrency: true },
  async () => {
    const { repoRoot, stateDir, ticket } = await pushableTicket();
    recordStage(stateDir, ticket.id, STAGES.ERGON);
    recordStage(stateDir, ticket.id, STAGES.REVIEW);
    setReviewToken(stateDir, ticket.id, 'the-real-token');
    appendReviewFinding(stateDir, ticket.id, {
      verdict: REVIEW_VERDICT.CLEAN,
      token: 'a-guessed-token',
    });

    await assert.rejects(
      () => epistle({ stateDir, id: ticket.id, repoRoot, createPr: () => 'unused' }),
      /no reviewer has actually looked at this diff/,
    );
    assert.equal(readTicket(stateDir, ticket.id).prUrl, null);
  },
);

// A REVIEW entry can exist even if no reviewer ran.
// Push must check for a real finding, not just the entry.
test(
  'epistle refuses a diff that was prepared for review but that nothing ever actually reviewed',
  { concurrency: true },
  async () => {
    const { repoRoot, stateDir, ticket } = await pushableTicket();
    recordStage(stateDir, ticket.id, STAGES.ERGON);
    recordStage(stateDir, ticket.id, STAGES.REVIEW); // No real finding was added after this.

    await assert.rejects(
      () => epistle({ stateDir, id: ticket.id, repoRoot, createPr: () => 'unused' }),
      /no reviewer has actually looked at this diff/,
    );
    assert.equal(readTicket(stateDir, ticket.id).prUrl, null);
  },
);

// A BLOCKING verdict must stop the push, even if "reviewed" passes.
test(
  'epistle refuses a blocking krisis verdict, even with a REVIEW stage recorded',
  { concurrency: true },
  async () => {
    const { repoRoot, stateDir, ticket } = await pushableTicket();
    recordStage(stateDir, ticket.id, STAGES.ERGON);
    recordStage(stateDir, ticket.id, STAGES.REVIEW);
    appendReviewFinding(stateDir, ticket.id, {
      verdict: REVIEW_VERDICT.BLOCKING,
      finding: 'signup.js:44 — no rate limit on invite redeem',
    });

    await assert.rejects(
      () => epistle({ stateDir, id: ticket.id, repoRoot, createPr: () => 'unused' }),
      (err: Error) => {
        assert.match(err.message, /found a blocking problem/);
        assert.match(err.message, /signup\.js:44 — no rate limit on invite redeem/);
        return true;
      },
    );
    assert.equal(readTicket(stateDir, ticket.id).prUrl, null);
  },
);

// --unreviewed skips "nobody reviewed yet".
// It must not skip a real blocking problem.
test('--unreviewed does not bypass a blocking krisis verdict', { concurrency: true }, async () => {
  const { repoRoot, stateDir, ticket } = await pushableTicket();
  recordStage(stateDir, ticket.id, STAGES.ERGON);
  recordStage(stateDir, ticket.id, STAGES.REVIEW);
  appendReviewFinding(stateDir, ticket.id, {
    verdict: REVIEW_VERDICT.BLOCKING,
    finding: 'real problem',
  });

  await assert.rejects(
    () =>
      epistle({ stateDir, id: ticket.id, repoRoot, unreviewed: true, createPr: () => 'unused' }),
    /found a blocking problem/,
  );
});

// A crashed reviewer is different from "never reviewed", and it blocks the push by default — but it
// is the reviewer's TOOLING failing, not its judgement, so no verdict exists either way. That is what --unreviewed is for. Without this, one flaky reviewer run made real, checks-green work unpushable by any documented command.
async function reviewerThatFailed() {
  const { repoRoot, stateDir, ticket } = await pushableTicket();
  fs.writeFileSync(path.join(ticket.worktree!, 'a.txt'), 'a\n');
  execFileSync('git', ['add', 'a.txt'], { cwd: ticket.worktree! });
  execFileSync('git', ['commit', '-q', '-m', 'add a'], { cwd: ticket.worktree! });

  const { ticket: prepared, prompt } = await ergonReview({
    stateDir,
    id: ticket.id,
    repoRoot,
    baseRef: 'main',
  });
  dispatchReviewer({ stateDir, ticket: prepared, prompt, agentCmd: 'exit 1' });
  await waitFor(
    () => backgroundStatus({ stateDir, id: ticket.id, role: 'reviewer' }).state === 'failed',
  );
  return { repoRoot, stateDir, ticket };
}

test(
  'epistle refuses when the dispatched reviewer process itself failed, and offers the override',
  { concurrency: true },
  async () => {
    const { repoRoot, stateDir, ticket } = await reviewerThatFailed();

    await assert.rejects(
      () => epistle({ stateDir, id: ticket.id, repoRoot, createPr: () => 'unused' }),
      (err: Error) =>
        /reviewer process itself failed/.test(err.message) &&
        // The old message named only dead ends: read the log, or review again.
        err.message.includes('--unreviewed'),
    );
  },
);

test(
  '--unreviewed pushes past a reviewer that failed, and records which gate it walked past',
  { concurrency: true },
  async () => {
    const { repoRoot, stateDir, ticket } = await reviewerThatFailed();

    await epistle({
      stateDir,
      id: ticket.id,
      repoRoot,
      unreviewed: true,
      createPr: () => 'https://x/1',
    });

    const log = readTicket(stateDir, ticket.id).stageLog;
    const last = log[log.length - 1]!;
    assert.equal(last.stage, STAGES.EPISTLE);
    // "unreviewed" alone would hide the difference between "nobody looked"
    // and "the reviewer broke".
    assert.equal(last.note, 'unreviewed (reviewer run failed), unverified');
  },
);

// The same class as above: the reviewer ran, finished, and said nothing anyone can read. No verdict
// exists, so --unreviewed covers it — and re-running the same reviewer is not an exit, because it produces the same nothing.
async function reviewerThatSaidNothing() {
  const { repoRoot, stateDir, ticket } = await pushableTicket();
  fs.writeFileSync(path.join(ticket.worktree!, 'a.txt'), 'a\n');
  execFileSync('git', ['add', 'a.txt'], { cwd: ticket.worktree! });
  execFileSync('git', ['commit', '-q', '-m', 'add a'], { cwd: ticket.worktree! });

  const { ticket: prepared, prompt } = await ergonReview({
    stateDir,
    id: ticket.id,
    repoRoot,
    baseRef: 'main',
  });
  dispatchReviewer({ stateDir, ticket: prepared, prompt, agentCmd: 'true' });
  await waitFor(
    () => backgroundStatus({ stateDir, id: ticket.id, role: 'reviewer' }).state === 'finished',
  );
  return { repoRoot, stateDir, ticket };
}

test(
  'epistle refuses an unreadable verdict by default, and names the override',
  { concurrency: true },
  async () => {
    const { repoRoot, stateDir, ticket } = await reviewerThatSaidNothing();

    await assert.rejects(
      () => epistle({ stateDir, id: ticket.id, repoRoot, createPr: () => 'unused' }),
      (err: Error) =>
        /recorded nothing readable/.test(err.message) && err.message.includes('--unreviewed'),
    );
  },
);

test(
  '--unreviewed pushes past an unreadable verdict, recorded as such',
  { concurrency: true },
  async () => {
    const { repoRoot, stateDir, ticket } = await reviewerThatSaidNothing();

    await epistle({
      stateDir,
      id: ticket.id,
      repoRoot,
      unreviewed: true,
      createPr: () => 'https://x/2',
    });

    const log = readTicket(stateDir, ticket.id).stageLog;
    assert.equal(
      log[log.length - 1]!.note,
      'unreviewed (reviewer recorded no verdict), unverified',
    );
  },
);

// A ticket can be reviewed but still fail checks.
// That must block push, even with --unreviewed.
test(
  'epistle refuses to push a ticket whose last review recorded failing checks',
  { concurrency: true },
  async () => {
    const { repoRoot, stateDir, ticket } = await pushableTicket();
    recordStage(stateDir, ticket.id, STAGES.ERGON);
    recordStage(stateDir, ticket.id, STAGES.REVIEW, RUN_OUTCOMES.CHECKS_FAILED);

    await assert.rejects(
      () => epistle({ stateDir, id: ticket.id, repoRoot, createPr: () => 'unused' }),
      /last review recorded failing checks/,
    );
    assert.equal(readTicket(stateDir, ticket.id).prUrl, null);
  },
);

test(
  'epistle still refuses a checks-failed review even with --unreviewed',
  { concurrency: true },
  async () => {
    const { repoRoot, stateDir, ticket } = await pushableTicket();
    recordStage(stateDir, ticket.id, STAGES.ERGON);
    recordStage(stateDir, ticket.id, STAGES.REVIEW, RUN_OUTCOMES.CHECKS_FAILED);

    await assert.rejects(
      () =>
        epistle({ stateDir, id: ticket.id, repoRoot, unreviewed: true, createPr: () => 'unused' }),
      /last review recorded failing checks/,
    );
  },
);

// "Checks unknown" used to be pushable, on the grounds that many projects have no
// checks. That let a real ticket through having run zero commands: a monorepo whose
// root defined no scripts, so nothing ran, and a clean review made it look finished.
// Nothing ran is not the same as nothing to run, and only a person can tell them apart.
async function reviewedButUnverified() {
  const made = await pushableTicket();
  recordStage(made.stateDir, made.ticket.id, STAGES.ERGON);
  recordStage(made.stateDir, made.ticket.id, STAGES.REVIEW, RUN_OUTCOMES.CHECKS_UNKNOWN);
  setReviewToken(made.stateDir, made.ticket.id, 'a-real-round-token');
  appendReviewFinding(made.stateDir, made.ticket.id, {
    verdict: REVIEW_VERDICT.CLEAN,
    token: 'a-real-round-token',
  });
  return made;
}

// A reviewer that finished and said "VERDICT: clean" in its own text, with nothing recorded through
// `krisis`. Checks are green, so the only thing standing between this and a push is how much that
// line is worth — and the answer used to be "as much as a recorded verdict".
async function reviewedWithLogLineCleanOnly() {
  const made = await pushableTicket();
  recordStage(made.stateDir, made.ticket.id, STAGES.ERGON);
  recordStage(made.stateDir, made.ticket.id, STAGES.REVIEW, RUN_OUTCOMES.OK);

  const { dir, logPath, exitCodePath, startedAtPath } = runFiles(
    made.stateDir,
    made.ticket.id,
    'reviewer',
  );
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(logPath, 'read the whole diff, nothing wrong\nVERDICT: clean\n');
  fs.writeFileSync(startedAtPath, String(Date.now()));
  // No pid file, so nothing reads as live. The exit code is what ends the run.
  fs.writeFileSync(exitCodePath, '0');
  return made;
}

test('epistle refuses to push a ticket whose checks never ran', { concurrency: true }, async () => {
  const { repoRoot, stateDir, ticket } = await reviewedButUnverified();

  await assert.rejects(
    () => epistle({ stateDir, id: ticket.id, repoRoot, createPr: () => 'unused' }),
    /nothing was verified/,
  );
  assert.equal(readTicket(stateDir, ticket.id).prUrl, null);
});

// A project with genuinely nothing to run is a real case, so there has to be a way through — one
// that leaves a mark. It used to be a second flag, `--unverified`, and two flags for one idea let a
// person open this gate while still believing the review gate had held.
test(
  '--unreviewed opens the checks gate, and records that nothing was verified',
  { concurrency: true },
  async () => {
    const { repoRoot, stateDir, ticket } = await reviewedButUnverified();

    const result = await epistle({
      stateDir,
      id: ticket.id,
      repoRoot,
      unreviewed: true,
      createPr: () => 'https://example/pull/10',
    });

    assert.equal(result.ticket.prUrl, 'https://example/pull/10');
    const notes = readTicket(stateDir, ticket.id)
      .stageLog.map((entry) => entry.note)
      .filter(Boolean);
    assert.ok(
      notes.some((note) => /unverified/.test(String(note))),
      `the push must say it skipped verification, got: ${JSON.stringify(notes)}`,
    );
  },
);

// The bypass is written for whoever opens the PR, and the ticket file is not
// somewhere they can see. It has to travel with the pull request itself.
test('a bypassed push names the skipped gates in the PR body', { concurrency: true }, async () => {
  const { repoRoot, stateDir, ticket } = await reviewedButUnverified();

  let body = '';
  await epistle({
    stateDir,
    id: ticket.id,
    repoRoot,
    unreviewed: true,
    createPr: (options: { body: string }) => {
      body = options.body;
      return 'https://example/pull/10';
    },
  });

  assert.match(body, /--unreviewed/);
  assert.match(body, /unverified/);
});

// The weakest evidence glafka accepts was the only kind it never questioned: a "clean" read out of
// the reviewer's own text proves nothing about who wrote it, and used to push with no gate at all.
test('a verdict only parsed from text refuses a plain push', { concurrency: true }, async () => {
  const { repoRoot, stateDir, ticket } = await reviewedWithLogLineCleanOnly();

  await assert.rejects(
    () => epistle({ stateDir, id: ticket.id, repoRoot, createPr: () => 'unused' }),
    /never recorded a verdict through glafka krisis/,
  );
});

// A branch keeps ONE pull request. `gh pr create` refuses a second, so a push to a branch that
// already has one used to send the commits and THEN throw — the work landed and the command still
// ended in an error, which reads as "the push failed".
test('a second push updates the open PR instead of failing to open another', async () => {
  const { repoRoot, stateDir, ticket } = await pushableTicket();

  let createCalls = 0;
  const result = await epistle({
    stateDir,
    id: ticket.id,
    repoRoot,
    unreviewed: true,
    createPr: () => {
      createCalls += 1;
      throw new PullRequestFailedError('a pull request for branch … already exists: #2');
    },
    // Stands in for GitHub answering "yes, #2 is open for this branch".
    findOpenPr: () => 'https://example/pull/2',
  });

  assert.equal(createCalls, 0, 'it must not even try to open a second PR');
  assert.equal(result.prUpdated, true);
  assert.equal(result.ticket.prUrl, 'https://example/pull/2');
  assert.equal(readTicket(stateDir, ticket.id).prUrl, 'https://example/pull/2');
});

// Passing checks are unaffected. Only "nothing ran" is gated.
test(
  'epistle still pushes a ticket whose checks actually passed',
  { concurrency: true },
  async () => {
    const { repoRoot, stateDir, ticket } = await pushableTicket();
    recordStage(stateDir, ticket.id, STAGES.ERGON);
    recordStage(stateDir, ticket.id, STAGES.REVIEW, RUN_OUTCOMES.OK);
    setReviewToken(stateDir, ticket.id, 'a-real-round-token');
    appendReviewFinding(stateDir, ticket.id, {
      verdict: REVIEW_VERDICT.CLEAN,
      token: 'a-real-round-token',
    });

    const result = await epistle({
      stateDir,
      id: ticket.id,
      repoRoot,
      createPr: () => 'https://example/pull/10',
    });

    assert.equal(result.ticket.prUrl, 'https://example/pull/10');
  },
);

// --unreviewed must leave a note in the log. It can't be hidden.
test('--unreviewed pushes, and records that it skipped review', { concurrency: true }, async () => {
  const { repoRoot, stateDir, ticket } = await pushableTicket();
  recordStage(stateDir, ticket.id, STAGES.ERGON);

  await epistle({
    stateDir,
    id: ticket.id,
    repoRoot,
    unreviewed: true,
    createPr: () => 'https://example/pull/10',
  });

  const log = readTicket(stateDir, ticket.id).stageLog;
  assert.equal(log[log.length - 1].stage, 'epistle');
  assert.equal(log[log.length - 1].note, 'unreviewed');
});

// If the agent is still running, say that, not "unreviewed".
test(
  'a live background run is reported instead of the missing review',
  { concurrency: true },
  async () => {
    const { repoRoot, stateDir, ticket } = await pushableTicket({ planContent: '1. do it' });
    const { pid } = await ergonBackground({
      stateDir,
      id: ticket.id,
      repoRoot,
      agentCmd: 'sleep 30',
    });

    await assert.rejects(
      () => epistle({ stateDir, id: ticket.id, repoRoot, createPr: () => 'unused' }),
      /background ergon run still/,
    );

    process.kill(pid!, 'SIGKILL');
  },
);

test(
  'AC-13: epistle refuses a ticket whose AC were never verified, even with --unreviewed',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    addBareRemote(repoRoot);
    const stateDir = tempStateDir();
    const content = '# T\n\n## Acceptance criteria\n\n- AC-1: a → b → c\n';
    const ticket = await genesis({ repoRoot, stateDir, content });
    fs.writeFileSync(path.join(ticket.worktree!, 'feature.txt'), 'x\n');
    execFileSync('git', ['add', 'feature.txt'], { cwd: ticket.worktree! });
    execFileSync('git', ['commit', '-q', '-m', 'feature'], { cwd: ticket.worktree! });

    assert.throws(
      () => epistlePrepare({ stateDir, id: ticket.id, repoRoot, unreviewed: true }),
      /AC-1 never verified/,
    );
  },
);

// Every way a round can leave the criteria unproven. `--unreviewed` skips none of them.
// `dirty` leaves an uncommitted file in the worktree before the round opens.
const NOT_PASSED: {
  name: string;
  dirty?: boolean;
  finish: (stateDir: string, id: string) => void;
  refusal: RegExp;
}[] = [
  { name: 'a round still open', finish: () => {}, refusal: /a verification round is still open/ },
  {
    name: 'a cannot',
    finish: (stateDir, id) =>
      appendVerifyResult(stateDir, id, { ac: 'AC-1', result: 'cannot', evidence: 'no app' }),
    refusal: /the last verification round ended cannot: AC-1 cannot be checked: no app/,
  },
  {
    name: 'an incomplete round',
    finish: (stateDir, id) =>
      closeVerifyRound(stateDir, id, {
        outcome: 'incomplete',
        detail: 'no result for AC-1',
        tokenHash: hashReviewToken('tok'),
      }),
    refusal: /the last verification round ended incomplete: no result for AC-1/,
  },
  {
    name: 'a pass on uncommitted changes',
    dirty: true,
    finish: (stateDir, id) =>
      appendVerifyResult(stateDir, id, {
        ac: 'AC-1',
        result: 'pass',
        evidence: 'ok',
        token: 'tok',
      }),
    refusal:
      /passed on uncommitted changes \(\?\? route\.ts\) — commit them, or gitignore\/delete them if they are generated, then verify again/,
  },
];

for (const { name, dirty, finish, refusal } of NOT_PASSED) {
  test(
    `AC-13: epistle refuses ${name}, even with --unreviewed`,
    { concurrency: true },
    async () => {
      const repoRoot = makeGitRepo();
      addBareRemote(repoRoot);
      const stateDir = tempStateDir();
      const content = '# T\n\n## Acceptance criteria\n\n- AC-1: a → b → c\n';
      const ticket = await genesis({ repoRoot, stateDir, content });
      const worktree = ticket.worktree!;
      fs.writeFileSync(path.join(worktree, 'feature.txt'), 'x\n');
      execFileSync('git', ['add', 'feature.txt'], { cwd: worktree });
      execFileSync('git', ['commit', '-q', '-m', 'feature'], { cwd: worktree });
      if (dirty) fs.writeFileSync(path.join(worktree, 'route.ts'), 'export {}\n');
      openVerifyRound(stateDir, ticket.id, {
        token: 'tok',
        ...codeState(worktree),
        spawned: false,
      });
      finish(stateDir, ticket.id);
      verifyGate({ stateDir, id: ticket.id });

      assert.throws(
        () => epistlePrepare({ stateDir, id: ticket.id, repoRoot, unreviewed: true }),
        refusal,
      );
    },
  );
}

// epistle's own rebase and docs commit change the tree after the criteria passed. The retry its own
// error names must still get past the criteria gate.
test(
  'the "retry just the PR" hint works on a ticket whose AC passed',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    addBareRemote(repoRoot);
    const stateDir = tempStateDir();
    const content = '# T\n\n## Acceptance criteria\n\n- AC-1: a → b → c\n';
    const ticket = await genesis({ repoRoot, stateDir, content });
    const worktree = ticket.worktree!;
    fs.writeFileSync(path.join(worktree, 'feature.txt'), 'x\n');
    execFileSync('git', ['add', 'feature.txt'], { cwd: worktree });
    execFileSync('git', ['commit', '-q', '-m', 'feature'], { cwd: worktree });
    openVerifyRound(stateDir, ticket.id, { token: 'tok', ...codeState(worktree), spawned: false });
    appendVerifyResult(stateDir, ticket.id, {
      ac: 'AC-1',
      result: 'pass',
      evidence: 'ok',
      token: 'tok',
    });
    assert.equal(verifyGate({ stateDir, id: ticket.id }).kind, 'passed');

    // The base moves, so epistle's rebase gives a new tree.
    fs.writeFileSync(path.join(repoRoot, 'other.txt'), 'someone else\n');
    execFileSync('git', ['add', 'other.txt'], { cwd: repoRoot });
    execFileSync('git', ['commit', '-q', '-m', 'other work'], { cwd: repoRoot });
    execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: repoRoot });

    const writeDocs = () => {
      const docs = path.join(worktree, 'docs/glafka/architecture');
      fs.mkdirSync(docs, { recursive: true });
      fs.writeFileSync(path.join(docs, 'ci.md'), 'synced\n');
    };
    await assert.rejects(
      () =>
        epistle({
          stateDir,
          id: ticket.id,
          repoRoot,
          unreviewed: true,
          runTidy: writeDocs,
          createPr: () => {
            throw new PullRequestFailedError('gh: not logged in');
          },
          findOpenPr: () => null,
        }),
      /retry just the PR/,
    );

    const retried = await epistle({
      stateDir,
      id: ticket.id,
      repoRoot,
      unreviewed: true,
      createPr: () => 'https://example/pull/12',
      findOpenPr: () => null,
    });
    assert.equal(retried.ticket.prUrl, 'https://example/pull/12');
  },
);

// --------------------------------------------------------------------------- Older bug fixes, tested
// below. ---------------------------------------------------------------------------

// A ticket branch that conflicts with a commit someone else pushed.
async function conflictingTicket(content = 'ship this') {
  const repoRoot = makeGitRepo();
  const remoteDir = addBareRemote(repoRoot);
  const stateDir = tempStateDir();
  fs.writeFileSync(path.join(repoRoot, 'f.txt'), 'base\n');
  execFileSync('git', ['add', 'f.txt'], { cwd: repoRoot });
  execFileSync('git', ['commit', '-q', '-m', 'seed f'], { cwd: repoRoot });
  execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: repoRoot });

  const ticket = await genesis({ repoRoot, stateDir, content });
  fs.writeFileSync(path.join(ticket.worktree!, 'f.txt'), 'ticket change\n');
  execFileSync('git', ['add', 'f.txt'], { cwd: ticket.worktree! });
  execFileSync('git', ['commit', '-q', '-m', 'ticket change'], { cwd: ticket.worktree! });

  // Someone else pushes a conflicting change, but only to the remote.
  fs.writeFileSync(path.join(repoRoot, 'f.txt'), 'their change\n');
  execFileSync('git', ['add', 'f.txt'], { cwd: repoRoot });
  execFileSync('git', ['commit', '-q', '-m', 'their change'], { cwd: repoRoot });
  execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: repoRoot });
  execFileSync('git', ['reset', '-q', '--hard', 'HEAD~1'], { cwd: repoRoot });

  return { repoRoot, remoteDir, stateDir, ticket };
}

// A rebase conflict must not leave git stuck mid-rebase.
// The worktree must go back to normal, ready to use again.
test(
  'a rebase conflict leaves the worktree on its branch and clean',
  { concurrency: true },
  async () => {
    const { repoRoot, stateDir, ticket } = await conflictingTicket();

    await assert.rejects(() =>
      epistle({
        stateDir,
        id: ticket.id,
        repoRoot,
        unreviewed: true,
        createPr: () => 'https://example.com/pr/1',
      }),
    );

    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: ticket.worktree!,
      encoding: 'utf8',
    });
    assert.equal(status.trim(), '', 'the worktree must be clean, not full of unmerged files');

    const head = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: ticket.worktree!,
      encoding: 'utf8',
    }).trim();
    assert.equal(head, ticket.branch, 'HEAD must be back on the ticket branch, not detached');

    assert.equal(
      fs.existsSync(path.join(ticket.worktree!, '.git', 'rebase-merge')) ||
        fs.existsSync(path.join(ticket.worktree!, '.git', 'rebase-apply')),
      false,
      'no rebase may still be in progress',
    );
  },
);

test('the error names the conflicting file', { concurrency: true }, async () => {
  const { repoRoot, stateDir, ticket } = await conflictingTicket();

  await assert.rejects(
    () =>
      epistle({
        stateDir,
        id: ticket.id,
        repoRoot,
        unreviewed: true,
        createPr: () => 'https://example.com/pr/1',
      }),
    /f\.txt/,
  );
});

// Pushing takes time (fetch, push, open a PR).
// Data written by others during that time must not be lost.
test(
  'a finding recorded while epistle is pushing is not erased',
  { concurrency: true },
  async () => {
    const { repoRoot, stateDir, ticket } = await pushableTicket();

    const result = await epistle({
      stateDir,
      id: ticket.id,
      repoRoot,
      unreviewed: true,
      // This copies what a slow network does: something else
      // writes to the ticket while the push is still running.
      createPr: () => {
        appendReviewFinding(stateDir, ticket.id, {
          verdict: REVIEW_VERDICT.BLOCKING,
          finding: 'landed while the push was in flight',
        });
        return 'https://example.com/pr/1';
      },
    });

    const after = readTicket(stateDir, ticket.id);
    assert.equal(after.prUrl, 'https://example.com/pr/1', 'the push result is still recorded');
    assert.equal(
      after.reviewFindings.length,
      1,
      'and the finding written during the window survives',
    );
    assert.equal(result.ticket.prUrl, 'https://example.com/pr/1');
  },
);

// The diff must use the same base branch the rebase used.
// If not, it wrongly includes other people's commits too.
test(
  'the diff is taken against the ref the rebase actually used',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    addBareRemote(repoRoot);
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'ship this', planContent: '1. x' });

    fs.writeFileSync(path.join(ticket.worktree!, 'mine.txt'), 'mine\n');
    execFileSync('git', ['add', 'mine.txt'], { cwd: ticket.worktree! });
    execFileSync('git', ['commit', '-q', '-m', 'my work'], { cwd: ticket.worktree! });

    // Someone else pushes a file to the base. Our local copy stays old.
    fs.writeFileSync(path.join(repoRoot, 'theirs.sh'), 'echo theirs\n');
    execFileSync('git', ['add', 'theirs.sh'], { cwd: repoRoot });
    execFileSync('git', ['commit', '-q', '-m', 'their work'], { cwd: repoRoot });
    execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: repoRoot });
    execFileSync('git', ['reset', '-q', '--hard', 'HEAD~1'], { cwd: repoRoot });

    const result = await epistle({
      stateDir,
      id: ticket.id,
      repoRoot,
      unreviewed: true,
      createPr: () => 'https://example.com/pr/1',
    });

    assert.doesNotMatch(
      result.docSyncPrompt ?? '',
      /theirs\.sh/,
      "another branch's files must not be described as this ticket's changes",
    );
    assert.equal(
      (result.hostExec ?? '').includes('theirs.sh'),
      false,
      'and the host-exec spotlight must not point at them either',
    );
  },
);

// Rebase must not run while a reviewer is still reading the code.
// It would rewrite the commits that review is based on.
test('epistle refuses to rebase under a live reviewer', { concurrency: true }, async () => {
  const { repoRoot, stateDir, ticket } = await pushableTicket();

  const { dir, pidPath, logPath } = runFiles(stateDir, ticket.id, 'reviewer');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(pidPath, String(process.pid));
  fs.writeFileSync(logPath, '');

  await assert.rejects(
    () =>
      epistle({
        stateDir,
        id: ticket.id,
        repoRoot,
        unreviewed: true,
        createPr: () => 'https://example.com/pr/1',
      }),
    /reviewer|review/i,
  );
});

// The bug: the tidy-up ran AFTER the push, against the main checkout, so its edits landed on the
// base branch uncommitted and nobody ever committed them. The architecture map went stale one
// ticket at a time.
test(
  'the tidy-up runs before the push and its doc edits are committed onto the branch',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    addBareRemote(repoRoot);
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'ship this' });

    execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'feature work'], {
      cwd: ticket.worktree!,
    });

    let headWhenTidyRan: string | null = null;
    const result = await epistle({
      unreviewed: true,
      stateDir,
      id: ticket.id,
      repoRoot,
      createPr: () => 'https://github.com/example/repo/pull/5',
      // Stands in for the doc agents: it writes what they would write.
      runTidy: () => {
        headWhenTidyRan = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: ticket.worktree!,
          encoding: 'utf8',
        }).trim();
        const docs = path.join(ticket.worktree!, 'docs/glafka/architecture');
        fs.mkdirSync(docs, { recursive: true });
        fs.writeFileSync(path.join(docs, 'ci.md'), 'this repo has a remote now\n');
      },
    });

    assert.deepEqual(result.tidyCommitted, ['docs/glafka/architecture/ci.md']);
    assert.notEqual(
      headWhenTidyRan,
      null,
      'the tidy-up must have run, and it must have run before the push',
    );

    // On the branch, in git, not left dirty in someone else's checkout.
    const committed = execFileSync('git', ['show', '--name-only', '--format=%s', 'HEAD'], {
      cwd: ticket.worktree!,
      encoding: 'utf8',
    });
    assert.match(committed, /docs: sync plan and architecture/);
    assert.match(committed, /docs\/glafka\/architecture\/ci\.md/);
    assert.equal(
      execFileSync('git', ['status', '--porcelain'], {
        cwd: ticket.worktree!,
        encoding: 'utf8',
      }).trim(),
      '',
      'nothing the tidy-up wrote is left uncommitted',
    );

    // And the push carried it: the branch on the remote holds the doc commit.
    assert.equal(result.ticket.prUrl, 'https://github.com/example/repo/pull/5');
  },
);

// Docs that already told the truth must not produce an empty commit.
test(
  'a tidy-up that changes nothing commits nothing, and the push still happens',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    addBareRemote(repoRoot);
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'ship this' });

    execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'feature work'], {
      cwd: ticket.worktree!,
    });
    const before = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: ticket.worktree!,
      encoding: 'utf8',
    }).trim();

    const result = await epistle({
      unreviewed: true,
      stateDir,
      id: ticket.id,
      repoRoot,
      createPr: () => 'https://github.com/example/repo/pull/6',
      runTidy: () => {},
    });

    assert.deepEqual(result.tidyCommitted, []);
    assert.equal(
      execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: ticket.worktree!,
        encoding: 'utf8',
      }).trim(),
      before,
      'no commit means no commit — not an empty one',
    );
    assert.equal(result.ticket.prUrl, 'https://github.com/example/repo/pull/6');
  },
);

// M6: a rebase by hand changes the code, so the criteria are checked again. Both messages
// on that path say how.
test('an AC ticket hears how to verify again, at the conflict and after the hand rebase', async () => {
  const content = '# T\n\n## Acceptance criteria\n\n- AC-1: a → b → c\n';
  const { repoRoot, stateDir, ticket } = await conflictingTicket(content);
  const worktree = ticket.worktree!;
  openVerifyRound(stateDir, ticket.id, { token: 'tok', ...codeState(worktree), spawned: false });
  appendVerifyResult(stateDir, ticket.id, {
    ac: 'AC-1',
    result: 'pass',
    evidence: 'ok',
    token: 'tok',
  });
  assert.equal(verifyGate({ stateDir, id: ticket.id }).kind, 'passed');
  const push = () =>
    epistle({
      stateDir,
      id: ticket.id,
      repoRoot,
      unreviewed: true,
      createPr: () => 'https://example.com/pr/1',
    });
  const hint = new RegExp(`after a rebase by hand, run glafka ergon ${ticket.id} --review`);
  await assert.rejects(push, (err: Error) => /f\.txt/.test(err.message) && hint.test(err.message));

  // The person rebases by hand: new commits, so new code.
  fs.writeFileSync(path.join(worktree, 'f.txt'), 'resolved\n');
  execFileSync('git', ['commit', '-q', '-am', 'resolved'], { cwd: worktree });
  assert.throws(
    () => epistlePrepare({ stateDir, id: ticket.id, repoRoot, unreviewed: true }),
    (err: Error) =>
      /the code changed after the criteria passed/.test(err.message) && hint.test(err.message),
  );
});
