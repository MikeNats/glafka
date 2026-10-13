import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeGitRepo } from '../helpers/gitFixture.js';
import { makeTempDir } from '../helpers/tempDir.js';
import { genesis } from '../../src/commands/genesis/genesis.js';
import { verifyGate } from '../../src/commands/epalitheusis/round.js';
import { roundOutcome } from '../../src/commands/epalitheusis/outcome.js';
import { verificationGap } from '../../src/commands/epalitheusis/verificationGap.js';
import { codeState } from '../../src/commands/epalitheusis/codeState.js';
import {
  openVerifyRound,
  appendVerifyResult,
  readTicket,
  updateTicket,
  closeVerifyRound,
  consumeVerifyRound,
  hashReviewToken,
  activeCriteria,
} from '../../src/ticket/ticketStore.js';
import { runFiles } from '../../src/ticket/paths.js';
import {
  prepareVerify,
  dispatchVerifier,
  formatVerifyBlock,
} from '../../src/commands/epalitheusis/epalitheusis.js';
import { backgroundStatus, killBackground } from '../../src/ticket/background.js';
import type { VerifyResult } from '../../src/types/ticket.js';

const A1 = { id: 'AC-1', text: 'a' };
const A2 = { id: 'AC-2', text: 'b' };
const r = (id: string, result: VerifyResult['result'], verified = true): VerifyResult => ({
  id,
  result,
  evidence: `${id} evidence`,
  at: 'now',
  verified,
});

test('close rules: changed code wins over everything', () => {
  const out = roundOutcome({
    criteria: [A1],
    results: [r('AC-1', 'pass')],
    changes: ['?? stray.txt'],
  });
  assert.equal(out.outcome, 'untrusted');
  assert.match(out.detail, /stray\.txt/);
});

test('close rules: a missing result is incomplete, and named', () => {
  const out = roundOutcome({ criteria: [A1, A2], results: [r('AC-1', 'pass')], changes: [] });
  assert.equal(out.outcome, 'incomplete');
  assert.match(out.detail, /AC-2/);
});

test('close rules: cannot beats fail', () => {
  const out = roundOutcome({
    criteria: [A1, A2],
    results: [r('AC-1', 'fail'), r('AC-2', 'cannot')],
    changes: [],
  });
  assert.equal(out.outcome, 'cannot');
  assert.match(out.detail, /AC-2 cannot be checked/);
});

test('close rules: fail names the AC and its evidence', () => {
  const out = roundOutcome({ criteria: [A1], results: [r('AC-1', 'fail')], changes: [] });
  assert.equal(out.outcome, 'failed');
  assert.match(out.detail, /AC-1 failed: AC-1 evidence/);
});

test('close rules: an untrusted pass is untrusted; the newest result per AC counts', () => {
  assert.equal(
    roundOutcome({ criteria: [A1], results: [r('AC-1', 'pass', false)], changes: [] }).outcome,
    'untrusted',
  );
  assert.equal(
    roundOutcome({ criteria: [A1], results: [r('AC-1', 'fail'), r('AC-1', 'pass')], changes: [] })
      .outcome,
    'passed',
  );
});

async function reviewableTicket(content: string) {
  const repoRoot = makeGitRepo();
  const stateDir = makeTempDir('state');
  const ticket = await genesis({ repoRoot, stateDir, content });
  fs.writeFileSync(path.join(ticket.worktree!, 'feature.txt'), 'x\n');
  execFileSync('git', ['add', 'feature.txt'], { cwd: ticket.worktree! });
  execFileSync('git', ['commit', '-q', '-m', 'feature'], { cwd: ticket.worktree! });
  return { repoRoot, stateDir, ticket: readTicket(stateDir, ticket.id) };
}

const AC_SPEC = '# T\n\n## Acceptance criteria\n\n- AC-1: a → b → c\n';

test('gate: no AC → skip; AC with no round → start', async () => {
  const plain = await reviewableTicket('task');
  assert.equal(verifyGate({ stateDir: plain.stateDir, id: plain.ticket.id }).kind, 'skip');
  const withAc = await reviewableTicket(AC_SPEC);
  assert.equal(verifyGate({ stateDir: withAc.stateDir, id: withAc.ticket.id }).kind, 'start');
});

test('gate: a manual round closes once every AC has a result; passed means same code', async () => {
  const { stateDir, ticket } = await reviewableTicket(AC_SPEC);
  openVerifyRound(stateDir, ticket.id, {
    token: 'tok',
    ...codeState(ticket.worktree!),
    spawned: false,
  });
  assert.equal(verifyGate({ stateDir, id: ticket.id }).kind, 'running');

  appendVerifyResult(stateDir, ticket.id, {
    ac: 'AC-1',
    result: 'pass',
    evidence: 'ok',
    token: 'tok',
  });
  assert.deepEqual(verifyGate({ stateDir, id: ticket.id }), { kind: 'passed', justClosed: true });
  assert.deepEqual(verifyGate({ stateDir, id: ticket.id }), { kind: 'passed', justClosed: false });
  assert.equal(verificationGap(readTicket(stateDir, ticket.id)), null);

  fs.writeFileSync(path.join(ticket.worktree!, 'later.txt'), 'y\n');
  assert.equal(verifyGate({ stateDir, id: ticket.id }).kind, 'start');
  assert.match(verificationGap(readTicket(stateDir, ticket.id))!, /code changed/);
});

test('gate: a failed round stays blocked until it is used, then a new round starts', async () => {
  const { stateDir, ticket } = await reviewableTicket(AC_SPEC);
  openVerifyRound(stateDir, ticket.id, {
    token: 'tok',
    ...codeState(ticket.worktree!),
    spawned: false,
  });
  appendVerifyResult(stateDir, ticket.id, { ac: 'AC-1', result: 'fail', evidence: 'got 500' });
  const gate = verifyGate({ stateDir, id: ticket.id });
  assert.equal(gate.kind, 'blocked');
  assert.match(verificationGap(readTicket(stateDir, ticket.id))!, /AC-1 failed/);
  // Asking again changes nothing: only acting on it (prepareReview) uses it up.
  assert.equal(verifyGate({ stateDir, id: ticket.id }).kind, 'blocked');

  consumeVerifyRound(stateDir, ticket.id, hashReviewToken('tok'));
  assert.equal(verifyGate({ stateDir, id: ticket.id }).kind, 'start');
});

test('AC-10: a file the verifier left behind makes the round untrusted, and is named', async () => {
  const { stateDir, ticket } = await reviewableTicket(AC_SPEC);
  openVerifyRound(stateDir, ticket.id, {
    token: 'tok',
    ...codeState(ticket.worktree!),
    spawned: false,
  });
  fs.writeFileSync(path.join(ticket.worktree!, 'stray.txt'), 'z\n');
  appendVerifyResult(stateDir, ticket.id, {
    ac: 'AC-1',
    result: 'pass',
    evidence: 'ok',
    token: 'tok',
  });
  // Blocked, not a free new round: the same code is measured from the round's close.
  const gate = verifyGate({ stateDir, id: ticket.id });
  assert.equal(gate.kind, 'blocked');
  const round = readTicket(stateDir, ticket.id).verification!;
  assert.equal(round.outcome, 'untrusted');
  assert.match(round.detail!, /stray\.txt/);
  assert.equal(verifyGate({ stateDir, id: ticket.id }).kind, 'blocked');

  // A change after the close is new code, so a new round is due.
  fs.writeFileSync(path.join(ticket.worktree!, 'fix.txt'), 'y\n');
  assert.equal(verifyGate({ stateDir, id: ticket.id }).kind, 'start');
});

test('dispatchVerifier opens a spawned round and starts a verifier run', async () => {
  const { repoRoot, stateDir, ticket } = await reviewableTicket(AC_SPEC);
  const verify = prepareVerify({ ticket, repoRoot, criteria: [{ id: 'AC-1', text: 'a → b → c' }] });
  assert.match(verify.verifierPrompt, new RegExp(`--token ${verify.token}`));
  assert.doesNotMatch(verify.prompt, /--token/);

  dispatchVerifier({ stateDir, ticket, verify, agentCmd: 'sleep 30' });
  try {
    const round = readTicket(stateDir, ticket.id).verification!;
    assert.equal(round.spawned, true);
    assert.equal(round.outcome, null);
    assert.equal(backgroundStatus({ stateDir, id: ticket.id, role: 'verifier' }).state, 'running');
    assert.equal(verifyGate({ stateDir, id: ticket.id }).kind, 'running');
  } finally {
    // The whole group: killing the shell alone would leave `sleep 30` behind.
    killBackground({ stateDir, id: ticket.id, role: 'verifier' });
  }
});

test('a spawned round whose verifier crashed closes incomplete', async () => {
  const { repoRoot, stateDir, ticket } = await reviewableTicket(AC_SPEC);
  const verify = prepareVerify({ ticket, repoRoot, criteria: [{ id: 'AC-1', text: 'a → b → c' }] });
  const { pid } = dispatchVerifier({ stateDir, ticket, verify, agentCmd: 'sleep 30' });
  try {
    // SIGKILL to the group: the wrapper shell never writes an exit code, so the run reads as crashed.
    process.kill(-pid!, 'SIGKILL');
    const deadline = Date.now() + 10_000;
    while (backgroundStatus({ stateDir, id: ticket.id, role: 'verifier' }).state !== 'crashed') {
      if (Date.now() > deadline) throw new Error('the verifier never read as crashed');
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(verifyGate({ stateDir, id: ticket.id }).kind, 'blocked');
    const round = readTicket(stateDir, ticket.id).verification!;
    assert.equal(round.outcome, 'incomplete');
    assert.match(round.detail!, /no result for AC-1/);
  } finally {
    killBackground({ stateDir, id: ticket.id, role: 'verifier' });
  }
});

test('formatVerifyBlock shows one line per AC and marks an untrusted pass', async () => {
  const { stateDir, ticket } = await reviewableTicket(AC_SPEC);
  openVerifyRound(stateDir, ticket.id, {
    token: 'tok',
    ...codeState(ticket.worktree!),
    spawned: false,
  });
  appendVerifyResult(stateDir, ticket.id, { ac: 'AC-1', result: 'pass', evidence: 'curl → 200' });
  const text = formatVerifyBlock(readTicket(stateDir, ticket.id), 'not-started').join('\n');
  assert.match(text, /AC-1 {2}\[pass \(not trusted — no round token\)\]/);
  assert.match(text, /evidence: curl → 200/);
});

test('an open manual round whose code changed closes as untrusted', async () => {
  const { stateDir, ticket } = await reviewableTicket(AC_SPEC);
  openVerifyRound(stateDir, ticket.id, {
    token: 'tok',
    ...codeState(ticket.worktree!),
    spawned: false,
  });
  // No result yet, and a new commit lands. There is no process to wait for.
  fs.writeFileSync(path.join(ticket.worktree!, 'fix.txt'), 'y\n');
  execFileSync('git', ['add', 'fix.txt'], { cwd: ticket.worktree! });
  execFileSync('git', ['commit', '-q', '-m', 'fix'], { cwd: ticket.worktree! });

  assert.equal(verifyGate({ stateDir, id: ticket.id }).kind, 'blocked');
  const round = readTicket(stateDir, ticket.id).verification!;
  assert.equal(round.outcome, 'untrusted');
  assert.match(round.detail!, /the code changed during the round: HEAD/);
  assert.equal(round.closedCode!.tree, codeState(ticket.worktree!).tree);
});

const tokenOf = (stateDir: string, id: string) => readTicket(stateDir, id).verification!.token;

test('C4: a round that passed on uncommitted changes leaves a gap that names them', async () => {
  const { stateDir, ticket } = await reviewableTicket(AC_SPEC);
  const worktree = ticket.worktree!;
  // The fix that makes AC-1 pass, never committed: a new file and an edit.
  fs.writeFileSync(path.join(worktree, 'route.ts'), 'export {}\n');
  fs.appendFileSync(path.join(worktree, 'feature.txt'), 'fix\n');
  openVerifyRound(stateDir, ticket.id, { token: 'tok', ...codeState(worktree), spawned: false });
  appendVerifyResult(stateDir, ticket.id, {
    ac: 'AC-1',
    result: 'pass',
    evidence: 'ok',
    token: 'tok',
  });
  // Blocked, not passed: a reviewer reads commits only, so it must not start yet.
  const gate = verifyGate({ stateDir, id: ticket.id });
  assert.equal(gate.kind, 'blocked');
  assert.match(
    gate.kind === 'blocked' ? gate.detail : '',
    /^the criteria passed on uncommitted changes \(M feature\.txt, \?\? route\.ts\)/,
  );
  assert.match(
    verificationGap(readTicket(stateDir, ticket.id))!,
    /^the criteria passed on uncommitted changes \(M feature\.txt, \?\? route\.ts\) — commit them, or gitignore\/delete them if they are generated, then verify again$/,
  );
});

test('C5: a spawned round with no verifier pid waits a minute, then closes incomplete', async () => {
  const { stateDir, ticket } = await reviewableTicket(AC_SPEC);
  openVerifyRound(stateDir, ticket.id, {
    token: 'tok',
    ...codeState(ticket.worktree!),
    spawned: true,
  });
  // The normal open-then-spawn moment: not closed by mistake.
  assert.equal(verifyGate({ stateDir, id: ticket.id }).kind, 'running');

  const longAgo = new Date(Date.now() - 2 * 60_000).toISOString();
  updateTicket(stateDir, ticket.id, (t) => ({
    verification: { ...t.verification!, openedAt: longAgo },
  }));
  const gate = verifyGate({ stateDir, id: ticket.id });
  assert.equal(gate.kind, 'blocked');
  assert.equal(readTicket(stateDir, ticket.id).verification!.outcome, 'incomplete');
});

// No pid means spawn() could not start the shell. Nothing would ever close the round.
test('C5: dispatchVerifier closes the round incomplete when the run gets no pid', async () => {
  const { repoRoot, stateDir, ticket } = await reviewableTicket(AC_SPEC);
  const verify = prepareVerify({ ticket, repoRoot, criteria: [{ id: 'AC-1', text: 'a → b → c' }] });
  const shell = process.env.GLAFKA_SHELL;
  process.env.GLAFKA_SHELL = path.join(ticket.worktree!, 'no-such-shell');
  try {
    assert.throws(
      () => dispatchVerifier({ stateDir, ticket, verify, agentCmd: 'sleep 30' }),
      /the verifier did not start: no process id/,
    );
  } finally {
    if (shell === undefined) delete process.env.GLAFKA_SHELL;
    else process.env.GLAFKA_SHELL = shell;
  }
  const round = readTicket(stateDir, ticket.id).verification!;
  assert.equal(round.outcome, 'incomplete');
  assert.match(round.detail!, /the verifier did not start/);
});

test('C6: close and use-up act only on the round the caller read', async () => {
  const { stateDir, ticket } = await reviewableTicket(AC_SPEC);
  const worktree = ticket.worktree!;
  openVerifyRound(stateDir, ticket.id, { token: 'old', ...codeState(worktree), spawned: false });
  const old = tokenOf(stateDir, ticket.id);
  // A newer round replaced it while a slow caller still held the old one.
  openVerifyRound(stateDir, ticket.id, { token: 'new', ...codeState(worktree), spawned: false });
  const stale = { outcome: 'failed' as const, detail: 'from the old round', tokenHash: old };
  assert.equal(closeVerifyRound(stateDir, ticket.id, stale), false);
  assert.equal(readTicket(stateDir, ticket.id).verification!.outcome, null);

  const current = tokenOf(stateDir, ticket.id);
  closeVerifyRound(stateDir, ticket.id, { ...stale, tokenHash: current });
  consumeVerifyRound(stateDir, ticket.id, old);
  assert.equal(readTicket(stateDir, ticket.id).verification!.consumed, false);
  consumeVerifyRound(stateDir, ticket.id, current);
  assert.equal(readTicket(stateDir, ticket.id).verification!.consumed, true);
});

// dispatchVerifier opens the round a moment before the new run replaces the old exit code.
test('C6: a finished verifier run from before the round opened does not close it', async () => {
  const { stateDir, ticket } = await reviewableTicket(AC_SPEC);
  const { dir, pidPath, exitCodePath, startedAtPath, logPath } = runFiles(
    stateDir,
    ticket.id,
    'verifier',
  );
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(pidPath, '999999');
  fs.writeFileSync(exitCodePath, '0');
  fs.writeFileSync(logPath, '');
  fs.writeFileSync(startedAtPath, String(Date.now() - 10_000));
  openVerifyRound(stateDir, ticket.id, {
    token: 'tok',
    ...codeState(ticket.worktree!),
    spawned: true,
  });
  assert.equal(verifyGate({ stateDir, id: ticket.id }).kind, 'running');
  assert.equal(readTicket(stateDir, ticket.id).verification!.outcome, null);
});

// A fail nobody acted on must reach a coder. A file change after the close must not throw it away.
test('N3: a failed round stays blocked after a code change, until it is used', async () => {
  const { stateDir, ticket } = await reviewableTicket(AC_SPEC);
  openVerifyRound(stateDir, ticket.id, {
    token: 'tok',
    ...codeState(ticket.worktree!),
    spawned: false,
  });
  appendVerifyResult(stateDir, ticket.id, { ac: 'AC-1', result: 'fail', evidence: 'got 500' });
  assert.equal(verifyGate({ stateDir, id: ticket.id }).kind, 'blocked');
  fs.writeFileSync(path.join(ticket.worktree!, 'app.log'), 'request\n');
  const gate = verifyGate({ stateDir, id: ticket.id });
  assert.equal(gate.kind, 'blocked');
  assert.equal(gate.kind === 'blocked' && gate.outcome, 'failed');

  consumeVerifyRound(stateDir, ticket.id, hashReviewToken('tok'));
  assert.equal(verifyGate({ stateDir, id: ticket.id }).kind, 'start');
});

// A committed fix is new code: the next round starts at once, with no second call.
test('a failed round closed by --status, then a committed fix: a new round starts', async () => {
  const { stateDir, ticket } = await reviewableTicket(AC_SPEC);
  const worktree = ticket.worktree!;
  openVerifyRound(stateDir, ticket.id, { token: 'tok', ...codeState(worktree), spawned: false });
  appendVerifyResult(stateDir, ticket.id, { ac: 'AC-1', result: 'fail', evidence: 'got 500' });
  assert.equal(verifyGate({ stateDir, id: ticket.id }).kind, 'blocked');
  fs.writeFileSync(path.join(worktree, 'fix.txt'), 'fixed\n');
  execFileSync('git', ['add', 'fix.txt'], { cwd: worktree });
  execFileSync('git', ['commit', '-q', '-m', 'fix'], { cwd: worktree });
  assert.equal(verifyGate({ stateDir, id: ticket.id }).kind, 'start');
});

// M1: the close judges the results saved under the lock, not the ones an earlier read saw.
test('a fail recorded after the close read the round is still judged', async () => {
  const { stateDir, ticket } = await reviewableTicket(AC_SPEC);
  const code = codeState(ticket.worktree!);
  openVerifyRound(stateDir, ticket.id, { token: 'tok', ...code, spawned: false });
  const pass = { ac: 'AC-1', result: 'pass' as const, evidence: 'ok', token: 'tok' };
  appendVerifyResult(stateDir, ticket.id, pass);
  // What closeRoundIfEnded read, before a person recorded a fail.
  const read = readTicket(stateDir, ticket.id).verification!;
  appendVerifyResult(stateDir, ticket.id, { ac: 'AC-1', result: 'fail', evidence: 'no button' });
  const closed = closeVerifyRound(stateDir, ticket.id, {
    judge: (locked) =>
      roundOutcome({
        criteria: activeCriteria(locked),
        results: locked.verification!.results,
        changes: [],
      }),
    tokenHash: read.token,
    code,
  });
  assert.equal(closed, true);
  const after = readTicket(stateDir, ticket.id).verification!;
  assert.equal(after.outcome, 'failed');
  assert.match(after.detail!, /AC-1 failed: no button/);
});
