import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeGitRepo } from '../helpers/gitFixture.js';
import { makeTempDir } from '../helpers/tempDir.js';
import { genesis } from '../../src/commands/genesis/genesis.js';
import { runErgon } from '../../installKit/bin/commands/ergon.js';
import { ergonReview, CoderFixableError } from '../../src/commands/ergon/ergon.js';
import {
  readTicket,
  openVerifyRound,
  appendVerifyResult,
  hashReviewToken,
  reviewerRoles,
  recordStage,
  STAGES,
  RUN_OUTCOMES,
  startCleanRound,
  setReviewedTree,
  appendReviewFinding,
} from '../../src/ticket/ticketStore.js';
import { headTree } from '../../src/util/git.js';
import { codeState } from '../../src/commands/epalitheusis/codeState.js';
import { closeRoundIfEnded } from '../../src/commands/epalitheusis/epalitheusis.js';
import { runFiles } from '../../src/ticket/paths.js';
import { readRunRecords } from '../../src/audit/record.js';
import { runKrisis } from '../../installKit/bin/commands/krisis.js';
import { resolvePushVerdict } from '../../src/commands/epistle/utils.js';
import { vima } from '../../src/commands/vima/vima.js';
import { backgroundStatus, killBackground } from '../../src/ticket/background.js';
import type { Config } from '../../src/types/config.js';
import { withoutAgentCmd } from '../helpers/noAgentEnv.js';

// These tests need no agent configured. Cleared here, so running this file directly is safe too.
withoutAgentCmd();

const AC_SPEC = '# T\n\n## Acceptance criteria\n\n- AC-1: a → b → c\n';

// Only the fields runErgon reads on these paths. Not a real .glafka.json.
function config(agents: Record<string, string> = {}): Config {
  return {
    baseRef: 'main',
    checksCmd: null,
    e2eCmd: null,
    checksTimeoutMs: 10_000,
    e2eTimeoutMs: 10_000,
    ergonTimeoutMs: 60_000,
    agents,
    maxReviewRounds: 3,
    notifyCmd: null,
    reviewDoc: null,
    observability: { enabled: false },
  } as unknown as Config;
}

async function capture(fn: () => Promise<void>): Promise<string> {
  const out: string[] = [];
  const { log, error } = console;
  console.log = (...a: unknown[]) => void out.push(a.join(' '));
  console.error = (...a: unknown[]) => void out.push(a.join(' '));
  try {
    await fn();
  } finally {
    console.log = log;
    console.error = error;
  }
  return out.join('\n');
}

async function committedTicket(content = AC_SPEC) {
  const repoRoot = makeGitRepo();
  const stateDir = makeTempDir('state');
  const ticket = await genesis({ repoRoot, stateDir, content });
  fs.writeFileSync(path.join(ticket.worktree!, 'feature.txt'), 'x\n');
  execFileSync('git', ['add', 'feature.txt'], { cwd: ticket.worktree! });
  execFileSync('git', ['commit', '-q', '-m', 'feature'], { cwd: ticket.worktree! });
  return { repoRoot, stateDir, id: ticket.id, worktree: ticket.worktree! };
}

const run = (
  repoRoot: string,
  stateDir: string,
  args: string[],
  agents = {},
  hasTty: () => boolean = () => false,
) =>
  runErgon({
    args,
    repoRoot,
    stateDir,
    config: config(agents),
    personaContent: null,
    profile: null,
    hasTty,
  });

// A finished reviewer whose trusted clean verdict covers the code at HEAD. QA comes after it.
function cleanReview(stateDir: string, id: string) {
  const token = startCleanRound(stateDir, id);
  setReviewedTree(stateDir, id, headTree(readTicket(stateDir, id).worktree!));
  recordStage(stateDir, id, STAGES.REVIEW, RUN_OUTCOMES.OK);
  const { dir, pidPath, exitCodePath, logPath } = runFiles(stateDir, id, 'reviewer');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(pidPath, '999999');
  fs.writeFileSync(exitCodePath, '0');
  fs.writeFileSync(logPath, '');
  appendReviewFinding(stateDir, id, { verdict: 'clean', token, callerOrigin: 'inside' });
}

// Every run a test may have started: each reviewer slot the ticket recorded, and the verifier.
function stopAll(stateDir: string, id: string): void {
  for (const role of [...reviewerRoles(readTicket(stateDir, id)), 'verifier']) {
    killBackground({ stateDir, id, role });
  }
}

test('AC-4 (CLI): --review starts a reviewer first, and a verifier after a clean review', async () => {
  const agents = { verifier: 'sleep 30', reviewer: 'sleep 30' };
  const fresh = await committedTicket();
  const reviewed = await committedTicket();
  cleanReview(reviewed.stateDir, reviewed.id);
  try {
    const first = await capture(() =>
      run(fresh.repoRoot, fresh.stateDir, [fresh.id, '--review'], agents),
    );
    assert.match(first, /reviewer started/);
    assert.equal(
      backgroundStatus({ stateDir: fresh.stateDir, id: fresh.id, role: 'verifier' }).state,
      'not-started',
    );

    const out = await capture(() =>
      run(reviewed.repoRoot, reviewed.stateDir, [reviewed.id, '--review'], agents),
    );
    assert.match(out, /QA tester started/);
    assert.equal(
      backgroundStatus({ stateDir: reviewed.stateDir, id: reviewed.id, role: 'verifier' }).state,
      'running',
    );
  } finally {
    stopAll(fresh.stateDir, fresh.id);
    stopAll(reviewed.stateDir, reviewed.id);
  }
});

test('AC-7: --review --status shows a failed AC with evidence, and starts no reviewer', async () => {
  const { repoRoot, stateDir, id, worktree } = await committedTicket();
  openVerifyRound(stateDir, id, { token: 'tok', ...codeState(worktree), spawned: false });
  appendVerifyResult(stateDir, id, { ac: 'AC-1', result: 'fail', evidence: 'got 500' });
  try {
    const out = await capture(() =>
      run(repoRoot, stateDir, [id, '--review', '--status'], { reviewer: 'sleep 30' }),
    );
    assert.match(out, /AC-1 {2}\[fail\]/);
    assert.match(out, /evidence: got 500/);
    assert.equal(backgroundStatus({ stateDir, id, role: 'reviewer' }).state, 'not-started');
  } finally {
    stopAll(stateDir, id);
  }
});

test('AC-9: --review --status after a clean review starts the QA round', async () => {
  const { repoRoot, stateDir, id } = await committedTicket();
  cleanReview(stateDir, id);
  try {
    const out = await capture(() =>
      run(repoRoot, stateDir, [id, '--review', '--status'], { verifier: 'sleep 30' }),
    );
    assert.match(out, /review clean — starting the QA round/);
    assert.equal(backgroundStatus({ stateDir, id, role: 'verifier' }).state, 'running');
  } finally {
    stopAll(stateDir, id);
  }
});

test('--review --stop stops the verifier too', async () => {
  const { repoRoot, stateDir, id } = await committedTicket();
  cleanReview(stateDir, id);
  try {
    await capture(() => run(repoRoot, stateDir, [id, '--review'], { verifier: 'sleep 30' }));
    const out = await capture(() => run(repoRoot, stateDir, [id, '--review', '--stop']));
    assert.match(out, /stopped: .*verifier/);
    assert.equal(readTicket(stateDir, id).verification!.outcome, null);
  } finally {
    stopAll(stateDir, id);
  }
});

test('--review --stop with nothing alive names the QA tester too', async () => {
  const { repoRoot, stateDir, id } = await committedTicket();
  const out = await capture(() => run(repoRoot, stateDir, [id, '--review', '--stop']));
  assert.match(out, /nothing to stop — no reviewer or QA tester run/);
});

// The token is the only proof of a real QA pass. An agent's shell has no terminal, and in the
// same-session flow that agent is the coder, so it must never see the token.
test('with no verifier agent and no terminal, no token is printed and no round opens', async () => {
  const { repoRoot, stateDir, id } = await committedTicket();
  cleanReview(stateDir, id);
  // Nothing starts, so the exit code is 1. That is its own test below.
  const exitCode = process.exitCode;
  const out = await capture(() => run(repoRoot, stateDir, [id, '--review']));
  process.exitCode = exitCode;
  assert.doesNotMatch(out, /--token/);
  assert.match(out, /at a real terminal/);
  assert.match(out, /glafka ergon .* --review/);
  assert.match(out, /agents.*verifier/);
  assert.equal(readTicket(stateDir, id).verification, null);
});

test('with no verifier agent, a person at a terminal gets the token and a manual round', async () => {
  const { repoRoot, stateDir, id } = await committedTicket();
  cleanReview(stateDir, id);
  const out = await capture(() => run(repoRoot, stateDir, [id, '--review'], {}, () => true));
  assert.match(out, /--token [0-9a-f]{32}/);
  assert.equal(readTicket(stateDir, id).verification!.spawned, false);
});

test('--review --status says why a new round is needed', async () => {
  const { repoRoot, stateDir, id, worktree } = await committedTicket();
  cleanReview(stateDir, id);
  openVerifyRound(stateDir, id, { token: 'tok', ...codeState(worktree), spawned: false });
  appendVerifyResult(stateDir, id, { ac: 'AC-1', result: 'fail', evidence: 'got 500' });
  const shown = await capture(() => run(repoRoot, stateDir, [id, '--review', '--status']));
  assert.match(shown, /fix the failed criteria and commit/);
  // `--review` acts on the fail once: it goes to the coder.
  await assert.rejects(
    () => ergonReview({ stateDir, id, repoRoot }),
    (err: Error) => err instanceof CoderFixableError,
  );

  const used = await capture(() => run(repoRoot, stateDir, [id, '--review', '--status']));
  assert.match(used, /this round's outcome was already acted on/);
  assert.doesNotMatch(used, /code changed/);

  fs.writeFileSync(path.join(worktree, 'later.txt'), 'y\n');
  const changed = await capture(() => run(repoRoot, stateDir, [id, '--review', '--status']));
  assert.match(changed, /the code changed since this round/);
});

// A clean verdict on older code says nothing about this code: no QA round starts from it.
test('C2: --review --status does not start QA from a clean verdict on older code', async () => {
  const { repoRoot, stateDir, id, worktree } = await committedTicket();
  cleanReview(stateDir, id);
  fs.writeFileSync(path.join(worktree, 'fix.txt'), 'x\n');
  execFileSync('git', ['add', 'fix.txt'], { cwd: worktree });
  execFileSync('git', ['commit', '-q', '-m', 'fix'], { cwd: worktree });

  const out = await capture(() =>
    run(repoRoot, stateDir, [id, '--review', '--status'], { verifier: 'sleep 30' }),
  );
  assert.doesNotMatch(out, /starting the QA round/);
  assert.match(out, /start the review: glafka ergon .* --review/);
  assert.equal(backgroundStatus({ stateDir, id, role: 'verifier' }).state, 'not-started');
});

test('A2: a clean review and a passed round say ready, and start nothing', async () => {
  const { repoRoot, stateDir, id, worktree } = await committedTicket();
  cleanReview(stateDir, id);
  openVerifyRound(stateDir, id, { token: 'tok', ...codeState(worktree), spawned: false });
  appendVerifyResult(stateDir, id, { ac: 'AC-1', result: 'pass', evidence: 'ok', token: 'tok' });
  assert.equal(closeRoundIfEnded({ stateDir, id }), true);

  const out = await capture(() =>
    run(repoRoot, stateDir, [id, '--review', '--status'], { verifier: 'sleep 30' }),
  );
  assert.match(out, /AC-1 {2}\[pass\]/);
  assert.match(out, /all acceptance criteria passed — ready/);
  assert.equal(backgroundStatus({ stateDir, id, role: 'verifier' }).state, 'not-started');
});

// A manual round's token is printed once. A person who lost it can start again.
test('C7: --review at a terminal replaces an open manual round with a fresh token', async () => {
  const { repoRoot, stateDir, id } = await committedTicket(`${AC_SPEC}- AC-2: d → e → f\n`);
  cleanReview(stateDir, id);
  const first = await capture(() => run(repoRoot, stateDir, [id, '--review'], {}, () => true));
  const before = readTicket(stateDir, id).verification!;
  appendVerifyResult(stateDir, id, { ac: 'AC-1', result: 'fail', evidence: 'half done' });

  // No terminal: an agent may not throw the person's round away. A refusal sets the exit code.
  const exitCode = process.exitCode;
  const refused = await capture(() => run(repoRoot, stateDir, [id, '--review']));
  process.exitCode = exitCode;
  assert.match(refused, /the QA round is still open/);
  assert.equal(readTicket(stateDir, id).verification!.token, before.token);

  const again = await capture(() => run(repoRoot, stateDir, [id, '--review'], {}, () => true));
  const after = readTicket(stateDir, id).verification!;
  assert.notEqual(after.token, before.token);
  assert.deepEqual(after.results, []);
  assert.equal(after.spawned, false);
  const token = (text: string) => /--token ([0-9a-f]{32})/.exec(text)![1];
  assert.notEqual(token(again), token(first));
  assert.equal(hashReviewToken(token(again)), after.token);
});

async function waitEnded(stateDir: string, id: string, role: string): Promise<void> {
  const start = Date.now();
  while (['running', 'stalled'].includes(backgroundStatus({ stateDir, id, role }).state)) {
    if (Date.now() - start > 60_000) throw new Error(`${role} never ended`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

// M4: a QA tester run the CLI started is in the audit once, under its own stage.
test('--review --status and the next --review record each ended QA tester run once', async () => {
  const { repoRoot, stateDir, id } = await committedTicket();
  cleanReview(stateDir, id);
  const agents = { verifier: 'cat > /dev/null', reviewer: 'sleep 30' };
  const watched = { ...config(agents), observability: { enabled: true } } as Config;
  const ergonCli = (args: string[]) =>
    runErgon({ args, repoRoot, stateDir, config: watched, personaContent: null, profile: null });
  const verifierRuns = () => readRunRecords(stateDir, id).filter((r) => r.role === 'verifier');
  // A blocked round sets the exit code. It is not this test file's result.
  const exitCode = process.exitCode;
  try {
    await capture(() => ergonCli([id, '--review']));
    await waitEnded(stateDir, id, 'verifier');
    await capture(() => ergonCli([id, '--review', '--status']));
    await capture(() => ergonCli([id, '--review', '--status']));
    assert.deepEqual(
      verifierRuns().map((r) => r.stage),
      ['verify'],
    );
    // The round ended incomplete. One --review uses it up, the next starts round 2.
    await capture(() => ergonCli([id, '--review']));
    await capture(() => ergonCli([id, '--review']));
    await waitEnded(stateDir, id, 'verifier');
    // No --status this time: the next --review records the ended run before it does anything.
    await capture(() => ergonCli([id, '--review']));
    assert.deepEqual(
      verifierRuns().map((r) => r.stage),
      ['verify', 'verify'],
    );
  } finally {
    process.exitCode = exitCode;
    stopAll(stateDir, id);
  }
});

// M7: with no reviewer agent, the printed brief IS the review. --status must not send the
// person back to --review, which would replace the krisis token they were just given.
test('a printed review brief counts as a started review, and its krisis verdict counts', async () => {
  const { repoRoot, stateDir, id } = await committedTicket();
  // A person at a terminal: only they are shown the clean token.
  const brief = await capture(() => run(repoRoot, stateDir, [id, '--review'], {}, () => true));
  const token = /--verdict clean --token ([0-9a-f]{32})/.exec(brief)![1]!;

  const status = await capture(() => run(repoRoot, stateDir, [id, '--review', '--status']));
  assert.match(status, /review run=none \(no subagent\)/);

  await capture(async () =>
    runKrisis({ args: [id, '--verdict', 'clean', '--token', token], stateDir }),
  );
  assert.equal(backgroundStatus({ stateDir, id, role: 'reviewer' }).state, 'finished');
  assert.deepEqual(resolvePushVerdict({ stateDir, id }), {
    source: 'krisis',
    verdict: 'clean',
    finding: null,
  });
});

// I1: at guardrails levels 3 and 4 the QA tester cannot run curl, so every round ends
// `cannot`. A person must hear that before paying for one.
async function ticketAtLevel(level: number) {
  const repoRoot = makeGitRepo();
  fs.mkdirSync(path.join(repoRoot, 'docs', 'glafka'), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, 'docs', 'glafka', 'guardrails.json'),
    `{ "level": ${level} }\n`,
  );
  const stateDir = makeTempDir('state');
  const ticket = await genesis({ repoRoot, stateDir, content: AC_SPEC });
  fs.writeFileSync(path.join(ticket.worktree!, 'feature.txt'), 'x\n');
  execFileSync('git', ['add', 'feature.txt'], { cwd: ticket.worktree! });
  execFileSync('git', ['commit', '-q', '-m', 'feature'], { cwd: ticket.worktree! });
  cleanReview(stateDir, ticket.id);
  return { repoRoot, stateDir, id: ticket.id };
}

async function stderrOf(fn: () => Promise<void>): Promise<string> {
  const err: string[] = [];
  const { log, error } = console;
  console.log = () => {};
  console.error = (...a: unknown[]) => void err.push(a.join(' '));
  try {
    await fn();
  } finally {
    console.log = log;
    console.error = error;
  }
  return err.join('\n');
}

for (const level of [3, 4]) {
  test(`--review warns on stderr when a QA round starts at guardrails level ${level}`, async () => {
    const { repoRoot, stateDir, id } = await ticketAtLevel(level);
    try {
      const err = await stderrOf(() =>
        run(repoRoot, stateDir, [id, '--review'], { verifier: 'cat > /dev/null' }),
      );
      assert.match(err, new RegExp(`guardrails level ${level}.*cannot run curl`));
      assert.match(err, /QA works at levels 0–2/);
    } finally {
      stopAll(stateDir, id);
    }
  });
}

test('--review gives no guardrails warning at level 2', async () => {
  const { repoRoot, stateDir, id } = await ticketAtLevel(2);
  try {
    const err = await stderrOf(() =>
      run(repoRoot, stateDir, [id, '--review'], { verifier: 'cat > /dev/null' }),
    );
    assert.doesNotMatch(err, /cannot run curl/);
  } finally {
    stopAll(stateDir, id);
  }
});

// M11: nothing was started, so a script driving this must not read it as "QA under way".
test('with no verifier agent and no terminal, --review exits 1', async () => {
  const { repoRoot, stateDir, id } = await committedTicket();
  cleanReview(stateDir, id);
  const exitCode = process.exitCode;
  try {
    await capture(() => run(repoRoot, stateDir, [id, '--review']));
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = exitCode;
  }
});

// Round 2, item 1: a ticket with no AC behaves exactly as before. The printed brief marks no
// reviewer started, so vima still asks for a person, and krisis changes no run state.
test('no AC: the printed review brief leaves vima and krisis as they always were', async () => {
  const { repoRoot, stateDir, id } = await committedTicket('# T\n\nno criteria here\n');
  recordStage(stateDir, id, STAGES.ERGON);
  const coder = runFiles(stateDir, id, 'coder');
  fs.mkdirSync(coder.dir, { recursive: true });
  fs.writeFileSync(coder.pidPath, '999999');
  fs.writeFileSync(coder.exitCodePath, '0');
  fs.writeFileSync(coder.logPath, '');
  const pings = path.join(makeTempDir('pings'), 'pings.txt');
  const vimaConfig = { ...config({ coder: 'cat > /dev/null' }), notifyCmd: `echo x >> "${pings}"` };
  const tickOnce = () => vima({ stateDir, id, repoRoot, config: vimaConfig });
  const pinged = () =>
    fs.existsSync(pings) ? fs.readFileSync(pings, 'utf8').split('\n').filter(Boolean).length : 0;

  // A person at a terminal: only they are shown the clean token.
  const brief = await capture(() => run(repoRoot, stateDir, [id, '--review'], {}, () => true));
  const token = /--verdict clean --token ([0-9a-f]{32})/.exec(brief)![1]!;
  assert.equal(backgroundStatus({ stateDir, id, role: 'reviewer' }).state, 'not-started');
  for (let i = 0; i < 2; i++)
    assert.equal((await tickOnce()).reason, 'verdict not-done — needs you');
  assert.equal(pinged(), 1);

  await capture(async () =>
    runKrisis({ args: [id, '--verdict', 'clean', '--token', token], stateDir }),
  );
  assert.equal(backgroundStatus({ stateDir, id, role: 'reviewer' }).state, 'not-started');
  assert.equal((await tickOnce()).reason, 'verdict not-done — needs you');
  assert.deepEqual(resolvePushVerdict({ stateDir, id }), {
    source: 'krisis',
    verdict: 'clean',
    finding: null,
  });
});

// With no terminal, the shell reading the brief is an agent's, and in this flow that is the coder.
// It must not be handed the clean token, or it could approve its own work.
test('with no terminal, the printed review brief holds no clean token', async () => {
  const { repoRoot, stateDir, id } = await committedTicket('# T\n\nno criteria here\n');
  const brief = await capture(() => run(repoRoot, stateDir, [id, '--review']));

  assert.doesNotMatch(brief, /--verdict clean --token/);
  assert.match(brief, new RegExp(`a person runs glafka ergon ${id} --review at a real terminal`));
  // Blocking needs no token, so the coder can still report a problem.
  assert.match(brief, /--verdict blocking --finding/);
});

// --status starts QA once the review is clean. It must read the caller's terminal, not the real one.
test('with no terminal, --status that starts QA prints no QA token either', async () => {
  const { repoRoot, stateDir, id } = await committedTicket();
  cleanReview(stateDir, id);
  const exitCode = process.exitCode;
  const brief = await capture(() => run(repoRoot, stateDir, [id, '--review', '--status']));
  process.exitCode = exitCode;

  assert.match(brief, /review clean — starting the QA round/);
  assert.doesNotMatch(brief, /--token/);
  assert.equal(readTicket(stateDir, id).verification, null);
});

// Two AC tickets in one repo, named so a wakeCmd can tell them apart.
async function twoTickets(second = AC_SPEC) {
  const repoRoot = makeGitRepo();
  const stateDir = makeTempDir('state');
  const ids: string[] = [];
  for (const [name, content] of [
    ['first', AC_SPEC],
    ['second', second],
  ] as const) {
    const ticket = await genesis({ repoRoot, stateDir, content, name });
    fs.writeFileSync(path.join(ticket.worktree!, 'feature.txt'), 'x\n');
    execFileSync('git', ['add', 'feature.txt'], { cwd: ticket.worktree! });
    execFileSync('git', ['commit', '-q', '-m', 'feature'], { cwd: ticket.worktree! });
    if (content === AC_SPEC) cleanReview(stateDir, ticket.id);
    ids.push(ticket.id);
  }
  return { repoRoot, stateDir, first: ids[0]!, second: ids[1]! };
}

// Round 2, item 4: one ticket's app that cannot start must not stop the rest of a sweep.
test('a sweep reports a failed app start against its ticket, and starts the others', async () => {
  const { repoRoot, stateDir, first, second } = await twoTickets();
  const dir = path.join(repoRoot, 'docs', 'glafka', 'architecture');
  fs.mkdirSync(dir, { recursive: true });
  const wakeCmd = 'case "$GLAFKA_TICKET_ID" in *first*) echo db down >&2; exit 1;; esac';
  fs.writeFileSync(path.join(dir, 'isolation.json'), JSON.stringify({ services: [], wakeCmd }));
  const exitCode = process.exitCode;
  try {
    const out = await capture(() =>
      run(repoRoot, stateDir, ['--review'], { verifier: 'cat > /dev/null' }),
    );
    assert.match(out, new RegExp(`${first}  the QA round could not start: `));
    assert.equal(backgroundStatus({ stateDir, id: first, role: 'verifier' }).state, 'not-started');
    assert.notEqual(
      backgroundStatus({ stateDir, id: second, role: 'verifier' }).state,
      'not-started',
    );
    // A partial batch: some QA really started, so the sweep exits 0.
    assert.notEqual(process.exitCode, 1);
  } finally {
    process.exitCode = exitCode;
    stopAll(stateDir, first);
    stopAll(stateDir, second);
  }
});

// Round 2, item 6: the sweep rule for the exit code. Nothing started anywhere → 1, else 0.
test('a sweep where one ticket started something exits 0, even if another started nothing', async () => {
  const { repoRoot, stateDir } = await twoTickets('# T\n\nno criteria here\n');
  const exitCode = process.exitCode;
  try {
    await capture(() => run(repoRoot, stateDir, ['--review']));
    assert.notEqual(process.exitCode, 1);
  } finally {
    process.exitCode = exitCode;
  }
});

// Round 2: a review a person was handed has no process to kill. Past the time limit,
// --status must not say it COULD NOT BE KILLED.
test('a printed review brief past the time limit is not reported as a run that could not be killed', async () => {
  const { repoRoot, stateDir, id } = await committedTicket();
  await capture(() => run(repoRoot, stateDir, [id, '--review']));
  const longAgo = Date.now() - 120_000;
  fs.writeFileSync(runFiles(stateDir, id, 'reviewer').startedAtPath, String(longAgo));
  const status = await capture(() => run(repoRoot, stateDir, [id, '--review', '--status']));
  assert.match(status, /review run=none \(no subagent\)/);
  assert.doesNotMatch(status, /COULD NOT BE KILLED/);
});
