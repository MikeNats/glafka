import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeGitRepo } from '../helpers/gitFixture.js';
import { makeTempDir } from '../helpers/tempDir.js';
import { genesis } from '../../src/commands/genesis/genesis.js';
import { vima } from '../../src/commands/vima/vima.js';
import { ergonReview } from '../../src/commands/ergon/ergon.js';
import {
  dispatchVerifier,
  codeState,
  closeRoundIfEnded,
  verificationGap,
} from '../../src/commands/epalitheusis/epalitheusis.js';
import { runFiles } from '../../src/ticket/paths.js';
import { readRunRecords } from '../../src/audit/record.js';
import { backgroundStatus, killBackground } from '../../src/ticket/background.js';
import {
  readTicket,
  recordStage,
  openVerifyRound,
  appendVerifyResult,
  addCriterionSkip,
  reviewRoundCount,
  STAGES,
  RUN_OUTCOMES,
} from '../../src/ticket/ticketStore.js';
import { withoutAgentCmd } from '../helpers/noAgentEnv.js';

// These tests need no agent configured. Cleared here, so running this file directly is safe too.
withoutAgentCmd();

// vima and the QA round: no state may start paid runs in a loop. None of these need `npm run build`.

const AC_SPEC = '# T\n\n## Acceptance criteria\n\n- AC-1: a → b → c\n';
// An agent that reads its prompt and does nothing. Enough to show whether vima started it.
const IDLE = 'cat > /dev/null';
const ROLES_SEEN = ['coder', 'reviewer', 'verifier'];

function fakeFinishedRun(stateDir: string, id: string, role: string, log = '') {
  const { dir, pidPath, exitCodePath, logPath } = runFiles(stateDir, id, role);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(pidPath, '999999');
  fs.writeFileSync(exitCodePath, '0');
  fs.writeFileSync(logPath, log);
}

function baseConfig(
  agents: Record<string, string> = {},
  {
    maxReviewRounds = 3,
    checksCmd = null,
    notifyCmd = null,
  }: { maxReviewRounds?: number; checksCmd?: string | null; notifyCmd?: string | null } = {},
) {
  return {
    baseRef: 'main',
    checksCmd,
    e2eCmd: null,
    checksTimeoutMs: 10_000,
    e2eTimeoutMs: 10_000,
    ergonTimeoutMs: 60_000,
    agents,
    maxReviewRounds,
    notifyCmd,
    reviewDoc: null,
    observability: { enabled: false },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const settled = (stateDir: string, id: string) => () =>
  ROLES_SEEN.every(
    (role) => !['running', 'stalled'].includes(backgroundStatus({ stateDir, id, role }).state),
  );

// A ticket with one commit, whose coder already ran and finished.
async function codedTicket({ guardrailsLevel = null }: { guardrailsLevel?: number | null } = {}) {
  const repoRoot = makeGitRepo();
  const stateDir = path.join(repoRoot, '.glafka');
  // Set before the ticket exists: the ticket pins the policy it was made under.
  if (guardrailsLevel !== null) {
    const docs = path.join(repoRoot, 'docs', 'glafka');
    fs.mkdirSync(docs, { recursive: true });
    fs.writeFileSync(path.join(docs, 'guardrails.json'), `{ "level": ${guardrailsLevel} }\n`);
  }
  const ticket = await genesis({ repoRoot, stateDir, content: AC_SPEC, planContent: '1. do it' });
  const worktree = ticket.worktree!;
  fs.writeFileSync(path.join(worktree, 'done.txt'), 'x\n');
  execFileSync('git', ['add', 'done.txt'], { cwd: worktree });
  execFileSync('git', ['commit', '-q', '-m', 'did it'], { cwd: worktree });
  recordStage(stateDir, ticket.id, STAGES.ERGON);
  fakeFinishedRun(stateDir, ticket.id, 'coder');
  return { repoRoot, stateDir, id: ticket.id, worktree };
}

// A spawned round whose QA tester already ended, with these results.
function endedRound(
  stateDir: string,
  id: string,
  worktree: string,
  results: { result: 'pass' | 'fail' | 'cannot'; token?: string; callerOrigin?: 'inside' }[] = [],
) {
  openVerifyRound(stateDir, id, { token: 'tok', ...codeState(worktree), spawned: true });
  for (const r of results) {
    appendVerifyResult(stateDir, id, { ac: 'AC-1', evidence: 'curl → x', ...r });
  }
  fakeFinishedRun(stateDir, id, 'verifier');
}

// Ticks vima `times` times, waiting out anything it started, and returns every result.
async function tick(
  times: number,
  args: { stateDir: string; id: string; repoRoot: string; config: ReturnType<typeof baseConfig> },
) {
  const results = [];
  for (let i = 0; i < times; i++) {
    results.push(await vima(args));
    await waitFor(settled(args.stateDir, args.id));
  }
  return results;
}

function stopAll(stateDir: string, id: string) {
  for (const role of ROLES_SEEN) killBackground({ stateDir, id, role });
}

test('C1: vima closes a QA round a person restarted, and starts the reviewer', async () => {
  const { repoRoot, stateDir, id, worktree } = await codedTicket();
  endedRound(stateDir, id, worktree);
  const config = baseConfig({ verifier: IDLE, reviewer: IDLE });
  try {
    const [blocked] = await tick(1, { stateDir, id, repoRoot, config });
    assert.match(blocked!.reason!, /ended incomplete/);

    // The person does what the message says: check again.
    const prepared = await ergonReview({ stateDir, id, repoRoot });
    assert.ok(prepared.verify);
    dispatchVerifier({
      stateDir,
      ticket: prepared.ticket,
      verify: prepared.verify,
      agentCmd: IDLE,
    });
    await waitFor(settled(stateDir, id));
    // Stands in for the QA tester's own trusted pass.
    appendVerifyResult(stateDir, id, {
      ac: 'AC-1',
      result: 'pass',
      evidence: 'curl → 200',
      token: prepared.verify.token,
      callerOrigin: 'inside',
    });

    const next = await vima({ stateDir, id, repoRoot, config });
    assert.equal(next.action, 'spawned-reviewer');
    assert.equal(readTicket(stateDir, id).verification!.outcome, 'passed');
  } finally {
    stopAll(stateDir, id);
  }
});

test('C2: every AC skipped after a blocked round starts a reviewer, not a coder', async () => {
  const { repoRoot, stateDir, id, worktree } = await codedTicket();
  // Round A: a reviewer said blocking, and a coder fixed it since.
  recordStage(stateDir, id, STAGES.REVIEW, RUN_OUTCOMES.OK);
  fakeFinishedRun(stateDir, id, 'reviewer', 'VERDICT: blocking — stale, already fixed\n');
  recordStage(stateDir, id, STAGES.ERGON);
  endedRound(stateDir, id, worktree, [{ result: 'cannot' }]);
  const config = baseConfig({ coder: IDLE, reviewer: IDLE });
  try {
    const stopped = await tick(2, { stateDir, id, repoRoot, config });
    assert.deepEqual(
      stopped.map((r) => r.action),
      ['none', 'none'],
    );
    addCriterionSkip(stateDir, id, { ac: 'AC-1', reason: 'no app for this ticket' });

    const after = await vima({ stateDir, id, repoRoot, config });
    assert.equal(after.action, 'spawned-reviewer');
    assert.equal(backgroundStatus({ stateDir, id, role: 'coder' }).state, 'finished');
  } finally {
    stopAll(stateDir, id);
  }
});

test('C3: a QA tester that leaves a new file each run gets one round, not a loop', async () => {
  const { repoRoot, stateDir, id } = await codedTicket();
  const config = baseConfig({ verifier: `${IDLE}; touch "evidence-$$.txt"` });
  try {
    const results = await tick(10, { stateDir, id, repoRoot, config });
    assert.equal(results.filter((r) => r.action === 'spawned-verifier').length, 1);
    const ticket = readTicket(stateDir, id);
    assert.equal(reviewRoundCount(ticket), 1);
    assert.equal(ticket.verification!.outcome, 'untrusted');
    assert.match(results.at(-1)!.reason!, /needs you/);
  } finally {
    stopAll(stateDir, id);
  }
});

// The hard rule: a blocked round with nothing changing never pays for another run.
for (const [name, results] of [
  ['incomplete', []],
  ['an untrusted pass', [{ result: 'pass' as const }]],
] as const) {
  test(`a blocked round (${name}) starts nothing over 7 vima ticks`, async () => {
    const { repoRoot, stateDir, id, worktree } = await codedTicket();
    endedRound(stateDir, id, worktree, [...results]);
    const config = baseConfig({ coder: IDLE, verifier: IDLE, reviewer: IDLE });
    try {
      const ticks = await tick(7, { stateDir, id, repoRoot, config });
      assert.deepEqual(
        ticks.filter((r) => r.action.startsWith('spawned')),
        [],
      );
      for (const r of ticks) assert.match(r.reason!, /needs you/);
      assert.equal(reviewRoundCount(readTicket(stateDir, id)), 1);
    } finally {
      stopAll(stateDir, id);
    }
  });
}

test('a person restarts QA and it blocks again: still nothing starts on its own', async () => {
  const { repoRoot, stateDir, id, worktree } = await codedTicket();
  endedRound(stateDir, id, worktree);
  const config = baseConfig({ coder: IDLE, verifier: IDLE, reviewer: IDLE });
  try {
    await tick(2, { stateDir, id, repoRoot, config });
    const prepared = await ergonReview({ stateDir, id, repoRoot });
    dispatchVerifier({
      stateDir,
      ticket: prepared.ticket,
      verify: prepared.verify!,
      agentCmd: IDLE,
    });
    await waitFor(settled(stateDir, id));

    const ticks = await tick(7, { stateDir, id, repoRoot, config });
    assert.deepEqual(
      ticks.filter((r) => r.action.startsWith('spawned')),
      [],
    );
    assert.equal(readTicket(stateDir, id).verification!.outcome, 'incomplete');
  } finally {
    stopAll(stateDir, id);
  }
});

test('a failed round acted on from a reviewed ticket is held to maxReviewRounds', async () => {
  const { repoRoot, stateDir, id, worktree } = await codedTicket();
  recordStage(stateDir, id, STAGES.REVIEW, RUN_OUTCOMES.OK);
  endedRound(stateDir, id, worktree, [{ result: 'fail' }]);
  // Closed by a `--status` call; nobody acted on it yet.
  closeRoundIfEnded({ stateDir, id });
  const config = baseConfig(
    { coder: IDLE, verifier: IDLE, reviewer: IDLE },
    { maxReviewRounds: 1 },
  );
  try {
    const result = await vima({ stateDir, id, repoRoot, config });
    assert.equal(result.action, 'none');
    assert.match(result.reason!, /AC-1 failed.*max review rounds \(1\) reached — needs you/s);
  } finally {
    stopAll(stateDir, id);
  }
});

// Counts how often a shell command ran: each run adds one line to a file outside the worktree.
function counter() {
  const file = path.join(makeTempDir('count'), 'count.txt');
  fs.writeFileSync(file, '');
  return {
    cmd: `echo x >> "${file}"`,
    count: () => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length,
  };
}

// The documented flow: `--status` closed a failed round, and the person is fixing the code.
test('N1: a reviewed ticket whose closed round has new code waits for a person', async () => {
  const { repoRoot, stateDir, id, worktree } = await codedTicket();
  endedRound(stateDir, id, worktree);
  const checks = counter();
  const notify = counter();
  const agents = { coder: IDLE, verifier: IDLE, reviewer: IDLE };
  const config = baseConfig(agents, { checksCmd: checks.cmd, notifyCmd: notify.cmd });
  try {
    await tick(1, { stateDir, id, repoRoot, config });
    // A person starts the next round, and `--status` closes it as failed.
    const prepared = await ergonReview({ stateDir, id, repoRoot, checksCmd: checks.cmd });
    dispatchVerifier({
      stateDir,
      ticket: prepared.ticket,
      verify: prepared.verify!,
      agentCmd: IDLE,
    });
    await waitFor(settled(stateDir, id));
    appendVerifyResult(stateDir, id, { ac: 'AC-1', result: 'fail', evidence: 'got 500' });
    assert.equal(closeRoundIfEnded({ stateDir, id }), true);
    fs.writeFileSync(path.join(worktree, 'fix.txt'), 'being fixed\n');
    const [checksBefore, notifyBefore] = [checks.count(), notify.count()];
    // The counters work: the first tick's review ran the checks and sent a note.
    assert.ok(
      checksBefore >= 1 && notifyBefore >= 1,
      `${checksBefore} checks, ${notifyBefore} notes`,
    );

    const ticks = await tick(7, { stateDir, id, repoRoot, config });
    assert.deepEqual(
      ticks.filter((r) => r.action.startsWith('spawned')),
      [],
    );
    for (const r of ticks)
      assert.match(r.reason!, /ended failed: AC-1 failed: got 500 — needs you/);
    assert.ok(
      checks.count() - checksBefore <= 1,
      `checks ran ${checks.count() - checksBefore} times`,
    );
    assert.ok(
      notify.count() - notifyBefore <= 1,
      `notified ${notify.count() - notifyBefore} times`,
    );
    assert.equal(readTicket(stateDir, id).verification!.consumed, false);
  } finally {
    stopAll(stateDir, id);
  }
});

// A failed result nobody acted on must reach a coder, not be thrown away by a later file change.
test('N3: a failed round closed by --status, then a file change, sends a coder', async () => {
  const { repoRoot, stateDir, id, worktree } = await codedTicket();
  endedRound(stateDir, id, worktree, [{ result: 'fail' }]);
  assert.equal(closeRoundIfEnded({ stateDir, id }), true);
  fs.writeFileSync(path.join(worktree, 'app.log'), 'request\n');
  const config = baseConfig({ coder: IDLE, verifier: IDLE, reviewer: IDLE });
  try {
    const result = await vima({ stateDir, id, repoRoot, config });
    assert.equal(result.action, 'spawned-coder');
    assert.match(result.reason!, /acceptance criteria failed — AC-1 failed: curl → x/);
    assert.equal(backgroundStatus({ stateDir, id, role: 'verifier' }).state, 'finished');
    assert.equal(readTicket(stateDir, id).verification!.consumed, true);
  } finally {
    stopAll(stateDir, id);
  }
});

// A reviewer reads commits only, so a pass on uncommitted files must not pay for one.
test('a pass on uncommitted changes starts no reviewer, over 7 ticks', async () => {
  const { repoRoot, stateDir, id, worktree } = await codedTicket();
  fs.writeFileSync(path.join(worktree, 'route.ts'), 'export {}\n');
  // Stands in for the QA tester's own trusted pass.
  endedRound(stateDir, id, worktree, [{ result: 'pass', token: 'tok', callerOrigin: 'inside' }]);
  const config = baseConfig({ coder: IDLE, verifier: IDLE, reviewer: IDLE });
  try {
    const ticks = await tick(7, { stateDir, id, repoRoot, config });
    assert.deepEqual(
      ticks.filter((r) => r.action.startsWith('spawned')),
      [],
    );
    assert.match(ticks[0]!.reason!, /passed on uncommitted changes \(\?\? route\.ts\)/);
    assert.equal(backgroundStatus({ stateDir, id, role: 'reviewer' }).state, 'not-started');
  } finally {
    stopAll(stateDir, id);
  }
});

// No mark on the stage log: `--status` closed the round, and a person skipped the failed AC.
// The reviewer log on disk is from before the round, so it must not send a coder.
test('N2: no reviewer since the round, every AC skipped: a reviewer starts, not a coder', async () => {
  const { repoRoot, stateDir, id, worktree } = await codedTicket();
  recordStage(stateDir, id, STAGES.REVIEW, RUN_OUTCOMES.OK);
  fakeFinishedRun(stateDir, id, 'reviewer', 'VERDICT: blocking — about older code\n');
  endedRound(stateDir, id, worktree, [{ result: 'fail' }]);
  assert.equal(closeRoundIfEnded({ stateDir, id }), true);
  addCriterionSkip(stateDir, id, { ac: 'AC-1', reason: 'not this ticket' });
  const config = baseConfig({ coder: IDLE, verifier: IDLE, reviewer: IDLE });
  try {
    const result = await vima({ stateDir, id, repoRoot, config });
    assert.equal(result.action, 'spawned-reviewer');
    assert.equal(backgroundStatus({ stateDir, id, role: 'coder' }).state, 'finished');
  } finally {
    stopAll(stateDir, id);
  }
});

// A review was tried after the round and started no reviewer. Trying again every tick would
// rerun the checks and write a review entry each time.
test('N2/N4: one review try that started no reviewer is not retried every tick', async () => {
  const { repoRoot, stateDir, id, worktree } = await codedTicket();
  endedRound(stateDir, id, worktree, [{ result: 'pass', token: 'tok', callerOrigin: 'inside' }]);
  assert.equal(closeRoundIfEnded({ stateDir, id }), true);
  // What a reviewer start that failed after its entry leaves behind.
  recordStage(stateDir, id, STAGES.REVIEW, RUN_OUTCOMES.OK);
  const config = baseConfig({ coder: IDLE, verifier: IDLE, reviewer: IDLE });
  try {
    const entries = () => readTicket(stateDir, id).stageLog.length;
    const before = entries();
    const ticks = await tick(6, { stateDir, id, repoRoot, config });
    assert.deepEqual(
      ticks.filter((r) => r.action.startsWith('spawned')),
      [],
    );
    for (const r of ticks) assert.match(r.reason!, /no reviewer has started since this QA round/);
    assert.equal(entries(), before);
  } finally {
    stopAll(stateDir, id);
  }
});

// The token in the QA tester's own prompt, as the spawned tester sees it.
function spawnedToken(stateDir: string, id: string): string {
  const prompt = fs.readFileSync(runFiles(stateDir, id, 'verifier').promptPath, 'utf8');
  return /--token ([0-9a-f]+)/.exec(prompt)![1]!;
}

// I4: a file glafka's own checks leave behind is not the coder's change.
test('a file the checks leave behind does not turn a trusted pass into a dirty pass', async () => {
  const { repoRoot, stateDir, id } = await codedTicket();
  const agents = { coder: IDLE, verifier: IDLE, reviewer: IDLE };
  const config = baseConfig(agents, { checksCmd: 'touch tsconfig.tsbuildinfo' });
  try {
    assert.equal((await vima({ stateDir, id, repoRoot, config })).action, 'spawned-verifier');
    await waitFor(settled(stateDir, id));
    const round = readTicket(stateDir, id).verification!;
    assert.deepEqual(round.dirty, []);
    assert.deepEqual(round.checkMade, ['?? tsconfig.tsbuildinfo']);
    const pass = { ac: 'AC-1', result: 'pass' as const, evidence: 'curl → 200' };
    const token = spawnedToken(stateDir, id);
    appendVerifyResult(stateDir, id, { ...pass, token, callerOrigin: 'inside' });
    assert.equal((await vima({ stateDir, id, repoRoot, config })).action, 'spawned-reviewer');
    assert.equal(verificationGap(readTicket(stateDir, id)), null);
  } finally {
    stopAll(stateDir, id);
  }
});

test('a file earlier checks left behind stays out of the next round too', async () => {
  const { repoRoot, stateDir, id, worktree } = await codedTicket();
  const checksCmd = 'touch tsconfig.tsbuildinfo';
  try {
    const first = await ergonReview({ stateDir, id, repoRoot, checksCmd });
    dispatchVerifier({ stateDir, ticket: first.ticket, verify: first.verify!, agentCmd: IDLE });
    await waitFor(settled(stateDir, id));
    appendVerifyResult(stateDir, id, { ac: 'AC-1', result: 'fail', evidence: 'got 500' });
    assert.equal(closeRoundIfEnded({ stateDir, id }), true);
    // The coder commits a fix. The file from the first checks is still there.
    fs.writeFileSync(path.join(worktree, 'fix.txt'), 'x\n');
    execFileSync('git', ['add', 'fix.txt'], { cwd: worktree });
    execFileSync('git', ['commit', '-q', '-m', 'fix'], { cwd: worktree });
    recordStage(stateDir, id, STAGES.ERGON);
    const second = await ergonReview({ stateDir, id, repoRoot, checksCmd });
    assert.deepEqual(second.verify!.checkMade, ['?? tsconfig.tsbuildinfo']);
  } finally {
    stopAll(stateDir, id);
  }
});

// I3: no verifier agent. A person is told once, and the checks do not run again every tick.
test('AC but no verifier agent: one notification and one checks run over 6 ticks', async () => {
  const { repoRoot, stateDir, id, worktree } = await codedTicket();
  // An app log: the worktree is dirty, so the checks cache never answers for them.
  fs.writeFileSync(path.join(worktree, 'app.log'), 'x\n');
  const checks = counter();
  const notify = counter();
  const config = baseConfig(
    { coder: IDLE, reviewer: IDLE },
    { checksCmd: checks.cmd, notifyCmd: notify.cmd },
  );
  try {
    const ticks = await tick(6, { stateDir, id, repoRoot, config });
    for (const r of ticks) {
      assert.equal(r.action, 'none');
      assert.match(r.reason!, /no verifier agent configured/);
    }
    // Only the tick that ran the checks may say they are green. The waiting ticks ran none.
    assert.match(ticks[0]!.reason!, /checks green/);
    for (const r of ticks.slice(1)) {
      assert.doesNotMatch(r.reason!, /checks green/);
      assert.match(r.reason!, /acceptance criteria wait for a QA tester/);
    }
    assert.equal(notify.count(), 1);
    assert.ok(checks.count() <= 1, `checks ran ${checks.count()} times`);
    assert.equal(readTicket(stateDir, id).verification, null);
  } finally {
    stopAll(stateDir, id);
  }
});

// M5: an AC fail on the last allowed round sends no coder. No QA round could check its work.
test('an AC fail on the last allowed round starts no coder', async () => {
  const { repoRoot, stateDir, id, worktree } = await codedTicket();
  endedRound(stateDir, id, worktree, [{ result: 'fail' }]);
  const config = baseConfig(
    { coder: IDLE, verifier: IDLE, reviewer: IDLE },
    { maxReviewRounds: 1 },
  );
  try {
    const result = await vima({ stateDir, id, repoRoot, config });
    assert.equal(result.action, 'none');
    assert.match(result.reason!, /AC-1 failed.*max review rounds \(1\) reached — needs you/s);
    // Still the coder run from before: no new one started.
    assert.equal(fs.readFileSync(runFiles(stateDir, id, 'coder').pidPath, 'utf8'), '999999');
    assert.equal(reviewRoundCount(readTicket(stateDir, id)), 1);
  } finally {
    stopAll(stateDir, id);
  }
});

// M4: each QA tester run is in the audit once, under its own stage, and its leftovers are reaped.
test('every verifier run is recorded once, under the verify stage', async () => {
  const { repoRoot, stateDir, id } = await codedTicket();
  const agents = { coder: IDLE, verifier: IDLE, reviewer: IDLE };
  const config = { ...baseConfig(agents), observability: { enabled: true } };
  const verifierRuns = () => readRunRecords(stateDir, id).filter((r) => r.role === 'verifier');
  try {
    assert.equal((await vima({ stateDir, id, repoRoot, config })).action, 'spawned-verifier');
    await tick(3, { stateDir, id, repoRoot, config });
    assert.equal(verifierRuns().length, 1);
    assert.ok(fs.existsSync(runFiles(stateDir, id, 'verifier').reapedPath));
    // A person starts the next round. Its run is recorded too, not lost to the new spawn.
    const prepared = await ergonReview({ stateDir, id, repoRoot });
    dispatchVerifier({
      stateDir,
      ticket: prepared.ticket,
      verify: prepared.verify!,
      agentCmd: IDLE,
    });
    await waitFor(settled(stateDir, id));
    await tick(2, { stateDir, id, repoRoot, config });
    assert.deepEqual(
      verifierRuns().map((r) => r.stage),
      ['verify', 'verify'],
    );
  } finally {
    stopAll(stateDir, id);
  }
});

// I1: vima says it too, once, on the tick that starts the QA tester.
test('vima names a strict guardrails level when it starts a QA tester', async () => {
  const { repoRoot, stateDir, id } = await codedTicket({ guardrailsLevel: 3 });
  const config = baseConfig({ coder: IDLE, verifier: IDLE, reviewer: IDLE });
  try {
    const started = await vima({ stateDir, id, repoRoot, config });
    assert.equal(started.action, 'spawned-verifier');
    assert.match(started.reason!, /guardrails level 3.*cannot run curl.*QA works at levels 0–2/);
  } finally {
    stopAll(stateDir, id);
  }
});

// Round 2, item 3: the wait must not hang on a notifyCmd. Without one, the checks still run once.
test('AC but no verifier agent and no notifyCmd: one checks run over 6 ticks', async () => {
  const { repoRoot, stateDir, id, worktree } = await codedTicket();
  fs.writeFileSync(path.join(worktree, 'app.log'), 'x\n');
  const checks = counter();
  const config = baseConfig({ coder: IDLE, reviewer: IDLE }, { checksCmd: checks.cmd });
  try {
    const ticks = await tick(6, { stateDir, id, repoRoot, config });
    for (const r of ticks) assert.match(r.reason!, /no verifier agent configured/);
    assert.ok(checks.count() <= 1, `checks ran ${checks.count()} times`);
  } finally {
    stopAll(stateDir, id);
  }
});
