import { test } from 'node:test';
import { resolveRoundVerdict } from '../../src/commands/ergon/utils.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeGitRepo, makeRepoWithSubmodule, withFileProtocol } from '../helpers/gitFixture.js';
import { genesis } from '../../src/commands/genesis/genesis.js';
import { spawnBackground } from '../../src/ticket/background.js';
import { makeTempDir } from '../helpers/tempDir.js';
import {
  ergonBackground,
  ergonReview,
  ergonReviewDecide,
  dispatchReviewer,
  CoderFixableError,
  NothingToReviewError,
  VerifyBlockedError,
  VerifyStillOpenError,
} from '../../src/commands/ergon/ergon.js';
import { checkoutBranchIn, headCommit } from '../../src/util/git.js';
import {
  readTicket,
  isClosed,
  hasOpenPr,
  currentStage,
  appendEthosCandidate,
  pendingCandidates,
  recordStage,
  STAGES,
  RUN_OUTCOMES,
  lastReviewOutcome,
  reviewRoundCount,
  appendReviewFinding,
  reviewFindings,
  hasBlockingFindings,
  REVIEW_VERDICT,
  openVerifyRound,
  appendVerifyResult,
  markNotified,
  wasNotified,
} from '../../src/ticket/ticketStore.js';
import { codeState } from '../../src/commands/epalitheusis/codeState.js';
import {
  prepareVerify,
  dispatchVerifier,
  closeRoundIfEnded,
} from '../../src/commands/epalitheusis/epalitheusis.js';
import { killBackground } from '../../src/ticket/background.js';
import { promoteEthosCandidates } from '../../src/memory/ethos.js';
import { architectureIndexPath, writeDoc, ethosPath, readDoc } from '../../src/memory/docsStore.js';
import { LEARNED_HEADING } from '../../src/memory/ethos.js';

// Tests `ergon --review`. It reads the diff, runs checks, and
// builds the review prompt. It does not change git state.

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

test(
  "ergonReview reads the ticket's committed diff without resetting or staging anything",
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'reviewable work' });

    fs.writeFileSync(path.join(ticket.worktree!, 'feature.txt'), 'new feature\n');
    execFileSync('git', ['add', 'feature.txt'], { cwd: ticket.worktree! });
    execFileSync('git', ['commit', '-q', '-m', 'add feature'], { cwd: ticket.worktree! });

    const { diff } = await ergonReview({ stateDir, id: ticket.id, repoRoot, baseRef: 'main' });

    // HEAD does not move. Nothing gets reset.
    const log = execFileSync('git', ['log', '--oneline', 'main..HEAD'], {
      cwd: ticket.worktree!,
      encoding: 'utf8',
    });
    assert.equal(
      log.trim().split('\n').length,
      2,
      'both real commits (gitignore + feature) stay on HEAD',
    );

    // Nothing gets staged. We only read the worktree.
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: ticket.worktree!,
      encoding: 'utf8',
    });
    assert.equal(status.trim(), '');

    // genesis adds its own .gitignore commit. That commit is part
    // of the diff too, just like the ticket's own work.
    assert.match(diff, /feature\.txt/);
    assert.match(diff, /\.gitignore/);
  },
);

// A plain `git diff` cannot show changes inside a submodule.
// `--submodule=diff` shows the real content instead of just a pointer bump.
test(
  "ergonReview shows a submodule's own content diff, without resetting or staging it either",
  { concurrency: true },
  async () => {
    const { repoRoot } = makeRepoWithSubmodule();
    const stateDir = tempStateDir();
    const ticket = await withFileProtocol(() =>
      genesis({ repoRoot, stateDir, content: 'full-stack change' }),
    );
    const submodule = path.join(ticket.worktree!, 'packages/real');
    const pinnedBefore = headCommit(submodule);

    // genesis leaves the submodule detached. Here we give it a
    // real branch and some commits, like a coder would.
    checkoutBranchIn(submodule, ticket.branch!);
    for (const [name, content] of [
      ['client-a.txt', 'a'],
      ['client-b.txt', 'b'],
      ['client-c.txt', 'c'],
    ]) {
      fs.writeFileSync(path.join(submodule, name), content);
      execFileSync('git', ['add', name], { cwd: submodule });
      execFileSync('git', ['commit', '-q', '-m', `add ${name}`], { cwd: submodule });
    }
    const submoduleHeadAfterCommits = headCommit(submodule);
    assert.notEqual(
      submoduleHeadAfterCommits,
      pinnedBefore,
      'three real commits landed inside the submodule first',
    );

    // A commit inside the submodule alone is invisible to the main repo.
    // We must also bump and commit the pointer.
    execFileSync('git', ['add', 'packages/real'], { cwd: ticket.worktree! });
    execFileSync('git', ['commit', '-q', '-m', 'bump packages/real'], { cwd: ticket.worktree! });

    const { diff } = await ergonReview({ stateDir, id: ticket.id, repoRoot, baseRef: 'main' });

    // The submodule is not reset back to its old commit.
    assert.equal(headCommit(submodule), submoduleHeadAfterCommits);
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: submodule,
      encoding: 'utf8',
    });
    assert.equal(status.trim(), '');

    // The diff shows the real submodule content, not just a pointer bump.
    assert.match(diff, /client-a\.txt/);
    assert.match(diff, /client-b\.txt/);
    assert.match(diff, /client-c\.txt/);
    assert.doesNotMatch(diff, /Subproject commit/);
  },
);

// Review only moves the ticket's stage. It does not open a PR or close it.
test('ergonReview records the review and nothing else', { concurrency: true }, async () => {
  const repoRoot = makeGitRepo();
  const stateDir = tempStateDir();
  const ticket = await genesis({ repoRoot, stateDir, content: 'task' });

  await ergonReview({ stateDir, id: ticket.id, repoRoot, baseRef: 'main' });

  const after = readTicket(stateDir, ticket.id);
  assert.equal(currentStage(after), 'review');
  assert.equal(hasOpenPr(after), false);
  assert.equal(isClosed(after), false);
});

test(
  "ergonReview returns a review prompt built from the ticket's own text and diff",
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'add a health check endpoint' });

    fs.writeFileSync(path.join(ticket.worktree!, 'health.js'), "app.get('/health')\n");
    execFileSync('git', ['add', 'health.js'], { cwd: ticket.worktree! });
    execFileSync('git', ['commit', '-q', '-m', 'add health endpoint'], { cwd: ticket.worktree! });

    const result = await ergonReview({ stateDir, id: ticket.id, repoRoot, baseRef: 'main' });

    assert.match(result.diff, /health\.js/);
    assert.match(result.prompt, /add a health check endpoint/);
    assert.match(result.prompt, /health\.js/);
    assert.equal(result.ticket.id, ticket.id);
  },
);

// The anti-self-approval token used to live in the one prompt string handed to every
// path, including the one printed straight to the coder's own stdout when no separate reviewer is configured. A coder that can read its own round's token can forge a verified "clean" verdict.
test(
  'ergonReview keeps the review token out of `prompt`, and only in `reviewerPrompt`',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });

    const result = await ergonReview({ stateDir, id: ticket.id, repoRoot, baseRef: 'main' });

    assert.ok(result.reviewToken.length > 0);
    assert.doesNotMatch(result.prompt, new RegExp(result.reviewToken));
    assert.doesNotMatch(result.prompt, /--token/);
    assert.match(result.reviewerPrompt, new RegExp(`--token ${result.reviewToken}`));
  },
);

test(
  'ergonReview tells the reviewer an unchecked diff is unverified, and why',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });

    const result = await ergonReview({ stateDir, id: ticket.id, repoRoot, baseRef: 'main' });

    assert.deepEqual(result.checks, []);
    // This note only shows when no checks ran. It stops "no checks"
    // from looking like "checks passed".
    assert.match(result.checksNote!, /nothing is proven/);
    assert.match(result.checksNote!, /odysse --checks/);
    assert.match(result.prompt, /UNVERIFIED/);
    assert.match(result.prompt, /odysse --checks/);
  },
);

// package.json lives on main BEFORE the ticket branches off it, so it is NOT part of this ticket's
// own diff (see below for what happens when a ticket's OWN diff touches package.json).
function seedPackageJson(repoRoot: string, scripts: Record<string, string>): void {
  fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({ name: 'x', scripts }));
  execFileSync('git', ['add', 'package.json'], { cwd: repoRoot });
  execFileSync('git', ['commit', '-q', '-m', 'add package.json'], { cwd: repoRoot });
}

test(
  'ergonReview leaves checksNote null when checks actually ran',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    seedPackageJson(repoRoot, { test: 'echo ok' });
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });

    const result = await ergonReview({ stateDir, id: ticket.id, repoRoot, baseRef: 'main' });

    assert.equal(result.checksNote, null);
    assert.doesNotMatch(result.prompt, /UNVERIFIED/);
  },
);

test(
  "ergonReview actually runs the worktree's own test script and reports the result",
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    seedPackageJson(repoRoot, { test: 'echo all good' });
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });

    const result = await ergonReview({ stateDir, id: ticket.id, repoRoot, baseRef: 'main' });

    assert.equal(result.checks.length, 1);
    assert.equal(result.checks[0].name, 'test');
    assert.equal(result.checks[0].passed, true);
    assert.match(result.checks[0].output, /all good/);
    assert.match(result.prompt, /test: PASSED/);
  },
);

// --------------------------------------------------------------------------- A failing diff never
// gets reviewed. There is nothing useful to learn from it. ---------------------------------------------------------------------------

test(
  'ergonReview refuses to build a review brief when checks fail, instead of paying for one',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    seedPackageJson(repoRoot, { test: 'exit 1' });
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });

    await assert.rejects(
      () => ergonReview({ stateDir, id: ticket.id, repoRoot, baseRef: 'main' }),
      /checks failed \(test\)/,
    );
  },
);

// The refusal still leaves a trace. Another command reads it to block a push.
test(
  'a refused review still records checks-failed on the REVIEW stage',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    seedPackageJson(repoRoot, { test: 'exit 1' });
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });

    await assert.rejects(() => ergonReview({ stateDir, id: ticket.id, repoRoot, baseRef: 'main' }));

    const updated = readTicket(stateDir, ticket.id);
    assert.equal(currentStage(updated), STAGES.REVIEW);
    assert.equal(lastReviewOutcome(updated), RUN_OUTCOMES.CHECKS_FAILED);
  },
);

// When the ticket's OWN diff touches package.json, the npm
// fallback must refuse rather than run scripts nobody has reviewed yet.
test(
  "ergonReview does not auto-run package.json's scripts when THIS ticket's own diff added them",
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });

    fs.writeFileSync(
      path.join(ticket.worktree!, 'package.json'),
      JSON.stringify({ name: 'x', scripts: { test: 'echo should-not-run' } }),
    );
    execFileSync('git', ['add', 'package.json'], { cwd: ticket.worktree! });
    execFileSync('git', ['commit', '-q', '-m', 'add package.json'], { cwd: ticket.worktree! });

    const result = await ergonReview({ stateDir, id: ticket.id, repoRoot, baseRef: 'main' });

    assert.equal(result.checks.length, 1);
    // Named `package.json`: the wider hostexec guard in front of both branches now answers to
    // `flagHostExecutingChanges`, which the DEFAULT level turns off — level 0 promises no cage, and
    // firing anyway left a checks gate nothing could move. This narrower guard has no switch, so
    // package.json's own scripts are still never run on the host unattended.
    assert.equal(result.checks[0].name, 'package.json');
    assert.equal(result.checks[0].passed, false);
    assert.equal(result.checks[0].unknown, true);
    assert.match(result.checks[0].output, /package\.json/);
    assert.doesNotMatch(result.checks[0].output, /should-not-run/);
  },
);

// "Checks unknown" is not the same as refused. Some projects have no test command set up yet.
test(
  'ergonReview does NOT refuse when checks are merely unknown, only when they actually fail',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });

    const result = await ergonReview({ stateDir, id: ticket.id, repoRoot, baseRef: 'main' });

    assert.deepEqual(result.checks, []);
    assert.match(result.prompt, /UNVERIFIED/);
  },
);

test(
  'ergonReview refuses outright when the ticket has no commits vs baseRef',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });
    // Undo the .gitignore commit genesis made, so this ticket has no changes.
    execFileSync('git', ['reset', '--hard', 'main'], { cwd: ticket.worktree! });

    await assert.rejects(
      () => ergonReview({ stateDir, id: ticket.id, repoRoot, baseRef: 'main' }),
      /has no commits vs main — nothing to review/,
    );
  },
);

// --------------------------------------------------------------------------- A new review round
// clears old findings. But if a reviewer from the last round is still running, its findings stay safe. ---------------------------------------------------------------------------

test(
  'a new review round wipes findings the previous round recorded',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });
    fs.writeFileSync(path.join(ticket.worktree!, 'a.txt'), 'a\n');
    execFileSync('git', ['add', 'a.txt'], { cwd: ticket.worktree! });
    execFileSync('git', ['commit', '-q', '-m', 'add a'], { cwd: ticket.worktree! });

    await ergonReview({ stateDir, id: ticket.id, repoRoot, baseRef: 'main' });
    appendReviewFinding(stateDir, ticket.id, {
      verdict: REVIEW_VERDICT.BLOCKING,
      finding: 'round 1 problem',
    });
    assert.equal(hasBlockingFindings(readTicket(stateDir, ticket.id)), true);

    // Round 2: same ticket, reviewed again.
    await ergonReview({ stateDir, id: ticket.id, repoRoot, baseRef: 'main' });

    assert.deepEqual(reviewFindings(readTicket(stateDir, ticket.id)), []);
    assert.equal(hasBlockingFindings(readTicket(stateDir, ticket.id)), false);
  },
);

test(
  'ergonReview refuses to start a new round while a reviewer from the last one is still live',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });
    fs.writeFileSync(path.join(ticket.worktree!, 'a.txt'), 'a\n');
    execFileSync('git', ['add', 'a.txt'], { cwd: ticket.worktree! });
    execFileSync('git', ['commit', '-q', '-m', 'add a'], { cwd: ticket.worktree! });

    const { ticket: prepared, prompt } = await ergonReview({
      stateDir,
      id: ticket.id,
      repoRoot,
      baseRef: 'main',
    });
    const reviewer = dispatchReviewer({ stateDir, ticket: prepared, prompt, agentCmd: 'sleep 30' });

    await assert.rejects(
      () => ergonReview({ stateDir, id: ticket.id, repoRoot, baseRef: 'main' }),
      /reviewer.*still running/s,
    );

    process.kill(reviewer.pid!, 'SIGKILL');
  },
);

test(
  'ergonReview uses a configured checksCmd/e2eCmd instead of package.json auto-detection',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });

    const result = await ergonReview({
      stateDir,
      id: ticket.id,
      repoRoot,
      baseRef: 'main',
      checksCmd: 'echo custom checks ok',
      e2eCmd: 'echo custom e2e ok',
    });

    assert.deepEqual(
      result.checks.map((c) => c.name),
      ['checks', 'e2e'],
    );
    assert.match(result.checks[0].output, /custom checks ok/);
    assert.match(result.checks[1].output, /custom e2e ok/);
  },
);

// The reviewer reads AGENTS.md itself. Adding a second copy here
// was a bug. This test checks that bug stays fixed.
test(
  "ergonReview does NOT embed this project's AGENTS.md — the reviewer reads it itself",
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });
    fs.writeFileSync(path.join(ticket.worktree!, 'AGENTS.md'), 'use uv for dependencies\n');

    const result = await ergonReview({ stateDir, id: ticket.id, repoRoot, baseRef: 'main' });

    assert.doesNotMatch(result.prompt, /## Project memory/);
    assert.doesNotMatch(result.prompt, /use uv for dependencies/);
  },
);

test(
  'ergonReview includes accumulated ethos conventions when they exist',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    promoteEthosCandidates(repoRoot, [{ target: 'ETHOS_DESIGN', text: 'no centered text' }]);
    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });

    const result = await ergonReview({ stateDir, id: ticket.id, repoRoot, baseRef: 'main' });

    assert.match(result.prompt, /## Project rules/);
    assert.match(result.prompt, /no centered text/);
  },
);

test(
  "ergonReview includes odysse's architecture index once it has been run",
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    writeDoc(architectureIndexPath(repoRoot), '# Architecture\n\n- src/commands/ — CLI commands\n');
    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });

    const result = await ergonReview({ stateDir, id: ticket.id, repoRoot, baseRef: 'main' });

    assert.match(result.prompt, /## Codebase map/);
    assert.match(result.prompt, /src\/commands\/ — CLI commands/);
  },
);

test(
  'ergonReview refuses while a background ergon run is still going',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'task', planContent: '1. do it' });
    const { pid } = await ergonBackground({
      stateDir,
      id: ticket.id,
      repoRoot,
      agentCmd: 'sleep 30',
    });

    await assert.rejects(
      () => ergonReview({ stateDir, id: ticket.id, repoRoot, baseRef: 'main' }),
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

test('ergonReview refuses when the last run ended badly', { concurrency: true }, async () => {
  const repoRoot = makeGitRepo();
  const stateDir = tempStateDir();
  const ticket = await genesis({ repoRoot, stateDir, content: 'task' });
  // There is no field to set directly, so we cause this state to happen.
  recordStage(stateDir, ticket.id, STAGES.ERGON, RUN_OUTCOMES.CRASHED);

  await assert.rejects(
    () => ergonReview({ stateDir, id: ticket.id, repoRoot, baseRef: 'main' }),
    /the last ergon run ended/,
  );
});

// A human decides on proposed rules here. Later steps only add
// a few more on top.
test(
  'ergonReviewDecide promotes the kept candidates into ## Learned and discards the rest',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });
    appendEthosCandidate(stateDir, ticket.id, {
      target: 'ETHOS_SECURITY',
      text: 'never log request bodies',
      source: 'you',
    });
    appendEthosCandidate(stateDir, ticket.id, { target: 'ETHOS_CODE', text: 'a guess' });

    const { kept, decided } = ergonReviewDecide({ repoRoot, stateDir, id: ticket.id, keep: '1' });

    assert.deepEqual(
      kept.map((c) => c.text),
      ['never log request bodies'],
    );
    assert.equal(decided, 2);

    const security = readDoc(ethosPath(repoRoot, 'ETHOS_SECURITY'));
    assert.match(security, /never log request bodies/);
    assert.ok(security.indexOf('never log request bodies') > security.indexOf(LEARNED_HEADING));
    assert.equal(fs.existsSync(ethosPath(repoRoot, 'ETHOS_CODE')), false);
  },
);

// Same bug as lysis's own fix: decidePendingCandidates writes the ticket ('kept')
// before promoteEthosCandidates could even run. If the promote then threw, a retry saw nothing pending left and silently promoted nothing, losing an already-approved rule for good.
test(
  'a promote failure leaves ergonReviewDecide candidates pending, not silently lost',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });
    appendEthosCandidate(stateDir, ticket.id, {
      target: 'ETHOS_SECURITY',
      text: 'never log request bodies',
      source: 'you',
    });

    // Block the write: a directory sits where the ethos doc should go.
    fs.mkdirSync(ethosPath(repoRoot, 'ETHOS_SECURITY'), { recursive: true });

    assert.throws(() => ergonReviewDecide({ repoRoot, stateDir, id: ticket.id, keep: 'all' }));

    // Still pending — not marked 'kept' with the rule gone.
    assert.equal(pendingCandidates(readTicket(stateDir, ticket.id)).length, 1);

    // Fix the cause and retry: the rule is still there to promote.
    fs.rmdirSync(ethosPath(repoRoot, 'ETHOS_SECURITY'));
    const { kept } = ergonReviewDecide({ repoRoot, stateDir, id: ticket.id, keep: 'all' });
    assert.deepEqual(
      kept.map((c) => c.text),
      ['never log request bodies'],
    );
    assert.match(readDoc(ethosPath(repoRoot, 'ETHOS_SECURITY')), /never log request bodies/);
  },
);

test(
  'ergonReviewDecide refuses without --keep, listing what awaits a decision',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });
    appendEthosCandidate(stateDir, ticket.id, { target: 'ETHOS_CODE', text: 'prefer composition' });

    assert.throws(
      () => ergonReviewDecide({ repoRoot, stateDir, id: ticket.id }),
      /1 ethos candidate\(s\) awaiting a decision/,
    );
    // Refused means nothing changed: still pending, nothing written.
    assert.equal(pendingCandidates(readTicket(stateDir, ticket.id)).length, 1);
    assert.equal(fs.existsSync(ethosPath(repoRoot, 'ETHOS_CODE')), false);
  },
);

test(
  'ergonReviewDecide on a ticket with nothing pending is a no-op, no flag needed',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });

    const { kept, decided } = ergonReviewDecide({ repoRoot, stateDir, id: ticket.id });

    assert.deepEqual(kept, []);
    assert.equal(decided, 0);
  },
);

// After review decides, closing must not ask about the same rules again.
test(
  'after ergonReviewDecide, nothing is left pending for lysis to ask about',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });
    appendEthosCandidate(stateDir, ticket.id, { target: 'ETHOS_CODE', text: 'one' });
    appendEthosCandidate(stateDir, ticket.id, { target: 'ETHOS_CODE', text: 'two' });

    ergonReviewDecide({ repoRoot, stateDir, id: ticket.id, keep: 'all' });

    assert.deepEqual(pendingCandidates(readTicket(stateDir, ticket.id)), []);
  },
);

// --------------------------------------------------------------------------- A big branch must
// review without crashing, and the round must be counted. --------------------------------------------------------------------------- Old bug: a big diff crashed before we saved the round count. So the round limit never triggered, and the coder kept running forever.
test('a diff past 1MB reviews normally and records the round', { concurrency: true }, async () => {
  const repoRoot = makeGitRepo();
  const stateDir = tempStateDir();
  const ticket = await genesis({ repoRoot, stateDir, content: 'task' });

  const lines = Array.from({ length: 60_000 }, (_, i) => `line ${i} ${'x'.repeat(20)}`);
  fs.writeFileSync(path.join(ticket.worktree!, 'big.txt'), `${lines.join('\n')}\n`);
  execFileSync('git', ['add', 'big.txt'], { cwd: ticket.worktree! });
  execFileSync('git', ['commit', '-q', '-m', 'big'], { cwd: ticket.worktree! });

  const result = await ergonReview({ stateDir, id: ticket.id, repoRoot, baseRef: 'main' });

  assert.ok(result.diff.length > 1024 * 1024, `diff was only ${result.diff.length} bytes`);
  // The round is logged, so the round limit can be reached.
  assert.equal(reviewRoundCount(readTicket(stateDir, ticket.id)), 1);
});

// We check for an empty diff with `--numstat`, so this check can't
// crash on a big branch. It must still refuse without using up a round.
test(
  'an empty branch is still refused, and does not consume a review round',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });
    execFileSync('git', ['reset', '--hard', 'main'], { cwd: ticket.worktree! });

    await assert.rejects(
      () => ergonReview({ stateDir, id: ticket.id, repoRoot, baseRef: 'main' }),
      /has no commits vs main — nothing to review/,
    );

    assert.equal(reviewRoundCount(readTicket(stateDir, ticket.id)), 0);
  },
);

// --------------------------------------------------------------------------- Old bug: reviewing with
// no id would stop at the first blocked ticket. Now it skips blocked tickets and keeps reviewing the rest. This runs the built app in dist/, not the source code. Run `npm run build` first.
const BIN = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'dist',
  'installKit',
  'bin',
  'glafka.js',
);

test(
  'ergon --review with no id keeps reviewing the rest after one ticket is blocked',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = path.join(repoRoot, '.glafka');

    // Created first, so it sorts ahead of the healthy ticket below.
    const blocked = await genesis({ repoRoot, stateDir, content: 'blocked ticket' });
    fs.writeFileSync(path.join(blocked.worktree!, 'a.txt'), 'a\n');
    execFileSync('git', ['add', 'a.txt'], { cwd: blocked.worktree! });
    execFileSync('git', ['commit', '-q', '-m', 'add a'], { cwd: blocked.worktree! });
    // A coder run that is still going.
    const coder = spawnBackground({ stateDir, id: blocked.id, agentCmd: 'sleep 30', prompt: '' });

    const healthy = await genesis({ repoRoot, stateDir, content: 'healthy ticket' });
    fs.writeFileSync(path.join(healthy.worktree!, 'b.txt'), 'b\n');
    execFileSync('git', ['add', 'b.txt'], { cwd: healthy.worktree! });
    execFileSync('git', ['commit', '-q', '-m', 'add b'], { cwd: healthy.worktree! });

    try {
      // With no GLAFKA_AGENT_CMD set, it just prints the prompt, no reviewer starts.
      // We delete the key. Setting it to undefined would turn into the text "undefined".
      const env = { ...process.env };
      delete env.GLAFKA_AGENT_CMD;
      const { stdout, stderr, status } = spawnSync('node', [BIN, 'ergon', '--review'], {
        cwd: repoRoot,
        encoding: 'utf8',
        env,
      });

      assert.equal(status, 0, `expected exit 0, got ${status}. stderr: ${stderr}`);
      assert.match(
        stderr,
        new RegExp(`${blocked.id}.*review preparation failed.*still running`, 's'),
      );
      // Shows the healthy ticket was prepared and printed, not skipped.
      assert.match(stdout, new RegExp(`reviewing ticket ${healthy.id}`));
    } finally {
      process.kill(coder.pid!, 'SIGKILL');
    }
  },
);

// --------------------------------------------------------------------------- Regressions

// The review count is the only limit on the retry loop. A bug used to
// save this count too late, so a failure could make the loop run forever.
test(
  'a review that cannot start still records a round, so the loop stays bounded',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'work' });

    fs.writeFileSync(path.join(ticket.worktree!, 'feature.txt'), 'x\n');
    execFileSync('git', ['add', 'feature.txt'], { cwd: ticket.worktree! });
    execFileSync('git', ['commit', '-q', '-m', 'add feature'], { cwd: ticket.worktree! });

    const before = reviewRoundCount(readTicket(stateDir, ticket.id));

    // A bad base ref makes this fail early, before the round
    // count would have been saved.
    await assert.rejects(() =>
      ergonReview({ stateDir, id: ticket.id, repoRoot, baseRef: 'no-such-ref' }),
    );

    assert.equal(
      reviewRoundCount(readTicket(stateDir, ticket.id)),
      before + 1,
      'the failed round must still count as a round',
    );
  },
);

// A round must be counted only once, even when the review succeeds.
test('a review that completes records exactly one round', { concurrency: true }, async () => {
  const repoRoot = makeGitRepo();
  const stateDir = tempStateDir();
  const ticket = await genesis({ repoRoot, stateDir, content: 'work' });

  fs.writeFileSync(path.join(ticket.worktree!, 'feature.txt'), 'x\n');
  execFileSync('git', ['add', 'feature.txt'], { cwd: ticket.worktree! });
  execFileSync('git', ['commit', '-q', '-m', 'add feature'], { cwd: ticket.worktree! });

  const before = reviewRoundCount(readTicket(stateDir, ticket.id));
  await ergonReview({ stateDir, id: ticket.id, repoRoot, baseRef: 'main' });
  assert.equal(reviewRoundCount(readTicket(stateDir, ticket.id)), before + 1);
});

// The caller must check the error type, not match text in the message.
test(
  'an unresolvable base ref is structural, not coder-fixable',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'work' });
    fs.writeFileSync(path.join(ticket.worktree!, 'feature.txt'), 'x\n');
    execFileSync('git', ['add', 'feature.txt'], { cwd: ticket.worktree! });
    execFileSync('git', ['commit', '-q', '-m', 'add feature'], { cwd: ticket.worktree! });

    await assert.rejects(
      () => ergonReview({ stateDir, id: ticket.id, repoRoot, baseRef: 'no-such-ref' }),
      (err: Error) => !(err instanceof CoderFixableError) && !(err instanceof NothingToReviewError),
    );
  },
);

test(
  'a coder that committed nothing raises NothingToReviewError',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'work' });
    // genesis adds a .gitignore commit, so reset the branch to main first.
    execFileSync('git', ['reset', '-q', '--hard', 'main'], { cwd: ticket.worktree! });

    await assert.rejects(
      () => ergonReview({ stateDir, id: ticket.id, repoRoot, baseRef: 'main' }),
      NothingToReviewError,
    );
  },
);

test(
  'failing checks are coder-fixable — more code really can fix them',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const ticket = await genesis({ repoRoot, stateDir, content: 'work' });
    fs.writeFileSync(path.join(ticket.worktree!, 'feature.txt'), 'x\n');
    execFileSync('git', ['add', 'feature.txt'], { cwd: ticket.worktree! });
    execFileSync('git', ['commit', '-q', '-m', 'add feature'], { cwd: ticket.worktree! });

    await assert.rejects(
      () =>
        ergonReview({
          stateDir,
          id: ticket.id,
          repoRoot,
          baseRef: 'main',
          checksCmd: 'exit 1',
        }),
      CoderFixableError,
    );
  },
);

// resolveRoundVerdict fell through to resolveVerdict, which reads statuses[0].logPath
// — so with two reviewers only the first one's log was ever parsed and a second reviewer's blocking line was dropped.
test('every reviewer log is read, and blocking wins', () => {
  const dir = makeTempDir('logs10');
  const cleanLog = path.join(dir, 'a.log');
  const blockingLog = path.join(dir, 'b.log');
  fs.writeFileSync(cleanLog, 'looks fine to me\nVERDICT: clean\n');
  fs.writeFileSync(blockingLog, 'found a problem\nVERDICT: blocking — src/x.ts:4 leaks a token\n');

  const finished = (logPath: string) => ({ state: 'finished', exitCode: 0, logPath }) as const;

  // The blocking one is SECOND, which is the case that was dropped.
  const verdict = resolveRoundVerdict({
    statuses: [finished(cleanLog), finished(blockingLog)],
    findings: [],
  });
  assert.equal(verdict.verdict, 'blocking');
  assert.equal(verdict.source, 'log-line');

  // And a missing line is not agreement: one clean, one silent is not clean.
  const silent = path.join(dir, 'c.log');
  fs.writeFileSync(silent, 'I had no opinion\n');
  assert.equal(
    resolveRoundVerdict({ statuses: [finished(cleanLog), finished(silent)], findings: [] }).verdict,
    null,
  );

  // Both clean really is clean.
  const clean2 = path.join(dir, 'd.log');
  fs.writeFileSync(clean2, 'VERDICT: clean\n');
  assert.equal(
    resolveRoundVerdict({ statuses: [finished(cleanLog), finished(clean2)], findings: [] }).verdict,
    'clean',
  );

  fs.rmSync(dir, { recursive: true, force: true });
});

const AC_SPEC = '# T\n\n## Acceptance criteria\n\n- AC-1: a → b → c\n';

async function committedTicket(content: string) {
  const repoRoot = makeGitRepo();
  const stateDir = tempStateDir();
  const ticket = await genesis({ repoRoot, stateDir, content });
  fs.writeFileSync(path.join(ticket.worktree!, 'feature.txt'), 'x\n');
  execFileSync('git', ['add', 'feature.txt'], { cwd: ticket.worktree! });
  execFileSync('git', ['commit', '-q', '-m', 'feature'], { cwd: ticket.worktree! });
  return { repoRoot, stateDir, ticket };
}

test('AC-14: no AC → reviewers are prepared as today', { concurrency: true }, async () => {
  const { repoRoot, stateDir, ticket } = await committedTicket('task');
  const prepared = await ergonReview({ stateDir, id: ticket.id, repoRoot, baseRef: 'main' });
  assert.equal(prepared.verify, null);
  assert.ok(prepared.reviewers.length > 0);
});

test(
  'AC-4: with AC, review returns the verifier and writes no review entry',
  { concurrency: true },
  async () => {
    const { repoRoot, stateDir, ticket } = await committedTicket(AC_SPEC);
    const prepared = await ergonReview({ stateDir, id: ticket.id, repoRoot, baseRef: 'main' });
    assert.ok(prepared.verify);
    assert.deepEqual(prepared.reviewers, []);
    assert.equal(lastReviewOutcome(readTicket(stateDir, ticket.id)), null);
  },
);

test(
  'a failed AC round sends the coder back with the AC and its evidence',
  { concurrency: true },
  async () => {
    const { repoRoot, stateDir, ticket } = await committedTicket(AC_SPEC);
    openVerifyRound(stateDir, ticket.id, {
      token: 'tok',
      ...codeState(ticket.worktree!),
      spawned: false,
    });
    appendVerifyResult(stateDir, ticket.id, { ac: 'AC-1', result: 'fail', evidence: 'got 500' });
    await assert.rejects(
      () => ergonReview({ stateDir, id: ticket.id, repoRoot, baseRef: 'main' }),
      (err: Error) => err instanceof CoderFixableError && /AC-1 failed: got 500/.test(err.message),
    );
    // Used once: the next call starts a fresh round.
    const next = await ergonReview({ stateDir, id: ticket.id, repoRoot, baseRef: 'main' });
    assert.ok(next.verify);
  },
);

test(
  'AC-8: a cannot round stops for a person and sets the aporia',
  { concurrency: true },
  async () => {
    const { repoRoot, stateDir, ticket } = await committedTicket(AC_SPEC);
    openVerifyRound(stateDir, ticket.id, {
      token: 'tok',
      ...codeState(ticket.worktree!),
      spawned: false,
    });
    appendVerifyResult(stateDir, ticket.id, {
      ac: 'AC-1',
      result: 'cannot',
      evidence: 'app does not start',
    });
    await assert.rejects(
      () => ergonReview({ stateDir, id: ticket.id, repoRoot, baseRef: 'main' }),
      (err: Error) => err instanceof VerifyBlockedError,
    );
    assert.match(readTicket(stateDir, ticket.id).aporia!.reason, /AC-1 cannot be checked/);
  },
);

test(
  'AC-9 (function level): a passed round goes on to the reviewers',
  { concurrency: true },
  async () => {
    const { repoRoot, stateDir, ticket } = await committedTicket(AC_SPEC);
    openVerifyRound(stateDir, ticket.id, {
      token: 'tok',
      ...codeState(ticket.worktree!),
      spawned: false,
    });
    appendVerifyResult(stateDir, ticket.id, {
      ac: 'AC-1',
      result: 'pass',
      evidence: 'ok',
      token: 'tok',
    });
    const prepared = await ergonReview({ stateDir, id: ticket.id, repoRoot, baseRef: 'main' });
    assert.equal(prepared.verify, null);
    assert.ok(prepared.reviewers.length > 0);
  },
);

test(
  'an open manual QA round clears nothing and uses up no round',
  { concurrency: true },
  async () => {
    const { repoRoot, stateDir, ticket } = await committedTicket(AC_SPEC);
    openVerifyRound(stateDir, ticket.id, {
      token: 'tok',
      ...codeState(ticket.worktree!),
      spawned: false,
    });
    appendReviewFinding(stateDir, ticket.id, { verdict: REVIEW_VERDICT.BLOCKING, finding: 'old' });
    markNotified(stateDir, ticket.id);
    const before = readTicket(stateDir, ticket.id);

    await assert.rejects(
      () => ergonReview({ stateDir, id: ticket.id, repoRoot, baseRef: 'main' }),
      (err: Error) =>
        err instanceof VerifyStillOpenError && /no result yet for AC-1/.test(err.message),
    );
    const after = readTicket(stateDir, ticket.id);
    // Cleared here, every vima tick would notify again while the round waits for a person.
    assert.equal(wasNotified(after), true);
    assert.deepEqual(reviewFindings(after), reviewFindings(before));
    assert.equal(after.reviewToken, before.reviewToken);
    assert.equal(lastReviewOutcome(after), null);
  },
);

test(
  'a live QA tester stops the review without using up a round',
  { concurrency: true },
  async () => {
    const { repoRoot, stateDir, ticket } = await committedTicket(AC_SPEC);
    const verify = prepareVerify({ ticket, repoRoot, criteria: [{ id: 'AC-1', text: 'a' }] });
    dispatchVerifier({ stateDir, ticket, verify, agentCmd: 'sleep 30' });
    try {
      await assert.rejects(
        () => ergonReview({ stateDir, id: ticket.id, repoRoot, baseRef: 'main' }),
        (err: Error) => err instanceof VerifyStillOpenError && /QA tester/.test(err.message),
      );
      assert.equal(lastReviewOutcome(readTicket(stateDir, ticket.id)), null);
    } finally {
      killBackground({ stateDir, id: ticket.id, role: 'verifier' });
    }
  },
);

// The in-session flow: `--status` showed the fail, the coder fixed it and committed. One
// `--review` must start the new QA round, not report the old fail again.
test(
  'a committed fix after --status closed a fail: one --review starts a new round',
  { concurrency: true },
  async () => {
    const { repoRoot, stateDir, ticket } = await committedTicket(AC_SPEC);
    const worktree = ticket.worktree!;
    openVerifyRound(stateDir, ticket.id, { token: 'tok', ...codeState(worktree), spawned: false });
    appendVerifyResult(stateDir, ticket.id, { ac: 'AC-1', result: 'fail', evidence: 'got 500' });
    assert.equal(closeRoundIfEnded({ stateDir, id: ticket.id }), true);
    fs.writeFileSync(path.join(worktree, 'fix.txt'), 'fixed\n');
    execFileSync('git', ['add', 'fix.txt'], { cwd: worktree });
    execFileSync('git', ['commit', '-q', '-m', 'fix'], { cwd: worktree });

    const prepared = await ergonReview({ stateDir, id: ticket.id, repoRoot, baseRef: 'main' });
    assert.ok(prepared.verify, 'a new QA round is due on the first call');
    assert.equal(lastReviewOutcome(readTicket(stateDir, ticket.id)), null);
  },
);

// Only uncommitted files changed: the fail is still the code's, so it goes to the coder once.
test(
  'an uncommitted change after --status closed a fail: the fail goes to the coder',
  { concurrency: true },
  async () => {
    const { repoRoot, stateDir, ticket } = await committedTicket(AC_SPEC);
    const worktree = ticket.worktree!;
    openVerifyRound(stateDir, ticket.id, { token: 'tok', ...codeState(worktree), spawned: false });
    appendVerifyResult(stateDir, ticket.id, { ac: 'AC-1', result: 'fail', evidence: 'got 500' });
    assert.equal(closeRoundIfEnded({ stateDir, id: ticket.id }), true);
    fs.writeFileSync(path.join(worktree, 'app.log'), 'request\n');

    await assert.rejects(
      () => ergonReview({ stateDir, id: ticket.id, repoRoot, baseRef: 'main' }),
      (err: Error) =>
        err instanceof CoderFixableError &&
        /AC-1 failed: got 500/.test(err.message) &&
        /fix them and commit, then re-run/.test(err.message),
    );
  },
);
