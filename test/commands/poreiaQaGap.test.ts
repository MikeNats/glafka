import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeGitRepo } from '../helpers/gitFixture.js';
import { genesis } from '../../src/commands/genesis/genesis.js';
import { codeState } from '../../src/commands/epalitheusis/codeState.js';
import { verificationGap } from '../../src/commands/epalitheusis/verificationGap.js';
import { verifyGate } from '../../src/commands/epalitheusis/round.js';
import { openVerifyRound, appendVerifyResult, readTicket } from '../../src/ticket/ticketStore.js';
import { poreiaJson } from '../../src/commands/poreia/json.js';

// poreia --json says whether the criteria still let this code be pushed: epistle's own check.
const SPEC = '# T\n\n## Acceptance criteria\n\n- AC-1: a → b → c\n';

async function passedTicket() {
  const repoRoot = makeGitRepo();
  const stateDir = path.join(repoRoot, '.glafka');
  const made = await genesis({ repoRoot, stateDir, content: SPEC });
  const worktree = made.worktree!;
  fs.writeFileSync(path.join(worktree, 'feature.txt'), 'x\n');
  execFileSync('git', ['add', 'feature.txt'], { cwd: worktree });
  execFileSync('git', ['commit', '-q', '-m', 'feature'], { cwd: worktree });
  openVerifyRound(stateDir, made.id, { token: 'tok', ...codeState(worktree), spawned: false });
  appendVerifyResult(stateDir, made.id, {
    ac: 'AC-1',
    result: 'pass',
    evidence: 'ok',
    token: 'tok',
  });
  // poreia only reads: the gate is what closes a finished round.
  verifyGate({ stateDir, id: made.id });
  const gapOf = () => poreiaJson({ stateDir, id: made.id, repoRoot }).qaGap;
  const epistleGap = () => verificationGap(readTicket(stateDir, made.id));
  return { stateDir, id: made.id, worktree, gapOf, epistleGap };
}

test('poreia --json qaGap: a criterion never checked stops the push', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = path.join(repoRoot, '.glafka');
  const ticket = await genesis({ repoRoot, stateDir, content: SPEC });

  assert.match(poreiaJson({ stateDir, id: ticket.id, repoRoot }).qaGap!, /AC-1 never verified/);
});

test('poreia --json qaGap: null with no criteria to check', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = path.join(repoRoot, '.glafka');
  const ticket = await genesis({ repoRoot, stateDir, content: 'a task with no criteria' });

  assert.equal(poreiaJson({ stateDir, id: ticket.id, repoRoot }).qaGap, null);
});

test('poreia --json qaGap: null while the pass covers this code, like epistle', async () => {
  const { gapOf, epistleGap } = await passedTicket();

  assert.equal(gapOf(), null);
  assert.equal(epistleGap(), null);
});

test('poreia --json qaGap: an uncommitted edit after the pass stops the push', async () => {
  const { worktree, gapOf, epistleGap } = await passedTicket();
  fs.writeFileSync(path.join(worktree, 'later.txt'), 'y\n');

  assert.match(gapOf()!, /code changed after the criteria passed: \?\? later\.txt/);
  assert.equal(gapOf(), epistleGap());
});

test('poreia --json qaGap: a pass on uncommitted changes stops the push', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = path.join(repoRoot, '.glafka');
  const made = await genesis({ repoRoot, stateDir, content: SPEC });
  fs.writeFileSync(path.join(made.worktree!, 'wip.txt'), 'x\n');
  openVerifyRound(stateDir, made.id, { token: 't', ...codeState(made.worktree!), spawned: false });
  appendVerifyResult(stateDir, made.id, { ac: 'AC-1', result: 'pass', evidence: 'ok', token: 't' });
  verifyGate({ stateDir, id: made.id });

  assert.match(poreiaJson({ stateDir, id: made.id, repoRoot }).qaGap!, /uncommitted changes/);
});

test('poreia --json qaGap: a worktree removed by hand is a reason, not a crash', async () => {
  const { worktree, gapOf } = await passedTicket();
  fs.rmSync(worktree, { recursive: true, force: true });

  assert.match(gapOf()!, /could not be compared with the QA pass/);
});
