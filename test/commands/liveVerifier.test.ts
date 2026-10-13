import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeGitRepo } from '../helpers/gitFixture.js';
import { makeTempDir } from '../helpers/tempDir.js';
import { genesis } from '../../src/commands/genesis/genesis.js';
import { ergon, ergonBackground, ergonReview } from '../../src/commands/ergon/ergon.js';
import { ticketChecks } from '../../src/commands/checks/checks.js';
import { lysis } from '../../src/commands/lysis/lysis.js';
import { cancel } from '../../src/commands/cancel/cancel.js';
import {
  prepareVerify,
  dispatchVerifier,
  openManualRound,
} from '../../src/commands/epalitheusis/epalitheusis.js';
import { backgroundStatus, killBackground } from '../../src/ticket/background.js';
import { readTicket } from '../../src/ticket/ticketStore.js';

// A QA tester tests the worktree as it is. Every command that changes the worktree, deletes
// it, or starts another round must wait for it, or the round is untrusted or lost.

const AC_SPEC = '# T\n\n## Acceptance criteria\n\n- AC-1: a → b → c\n';

async function ticketUnderQa() {
  const repoRoot = makeGitRepo();
  const stateDir = makeTempDir('state');
  const created = await genesis({ repoRoot, stateDir, content: AC_SPEC, planContent: '1. do it' });
  fs.writeFileSync(path.join(created.worktree!, 'done.txt'), 'x\n');
  execFileSync('git', ['add', 'done.txt'], { cwd: created.worktree! });
  execFileSync('git', ['commit', '-q', '-m', 'did it'], { cwd: created.worktree! });
  const ticket = readTicket(stateDir, created.id);
  const criteria = [{ id: 'AC-1', text: 'a → b → c' }];
  const verify = prepareVerify({ ticket, repoRoot, criteria });
  return { repoRoot, stateDir, ticket, verify };
}

// Started by each test inside its try, so the finally always stops it.
function startTester({ stateDir, ticket, verify }: Ctx): void {
  dispatchVerifier({ stateDir, ticket, verify, agentCmd: 'sleep 30' });
  assert.equal(backgroundStatus({ stateDir, id: ticket.id, role: 'verifier' }).state, 'running');
}

type Ctx = Awaited<ReturnType<typeof ticketUnderQa>>;

const SITES: [string, (ctx: Ctx) => unknown][] = [
  // A1: these two used to go ahead and change the worktree mid-round.
  [
    'a coder restart (ergonBackground)',
    ({ repoRoot, stateDir, ticket }) =>
      ergonBackground({
        stateDir,
        id: ticket.id,
        repoRoot,
        agentCmd: 'sleep 30',
        ensureApp: false,
      }),
  ],
  [
    'a same-session coder (ergon)',
    ({ repoRoot, stateDir, ticket }) =>
      ergon({ stateDir, id: ticket.id, repoRoot, ensureApp: false }),
  ],
  [
    'glafka checks',
    ({ repoRoot, stateDir, ticket }) =>
      ticketChecks({ stateDir, id: ticket.id, repoRoot, baseRef: 'main' }),
  ],
  [
    'a review round',
    ({ repoRoot, stateDir, ticket }) => ergonReview({ stateDir, id: ticket.id, repoRoot }),
  ],
  [
    'a second QA tester',
    ({ stateDir, ticket, verify }) =>
      dispatchVerifier({ stateDir, ticket, verify, agentCmd: 'sleep 30' }),
  ],
  [
    'a manual round',
    ({ stateDir, ticket, verify }) => openManualRound({ stateDir, ticket, verify }),
  ],
  ['lysis', ({ repoRoot, stateDir, ticket }) => lysis({ repoRoot, stateDir, id: ticket.id })],
  ['cancel', ({ repoRoot, stateDir, ticket }) => cancel({ repoRoot, stateDir, id: ticket.id })],
];

for (const [name, run] of SITES) {
  test(`${name} waits for a live QA tester`, async () => {
    const ctx = await ticketUnderQa();
    try {
      startTester(ctx);
      await assert.rejects(async () => run(ctx), /verifier run still running .*QA tester/);
      // Nothing else was started, and the round is still the tester's.
      assert.equal(
        backgroundStatus({ stateDir: ctx.stateDir, id: ctx.ticket.id }).state,
        'not-started',
      );
      assert.equal(readTicket(ctx.stateDir, ctx.ticket.id).verification!.spawned, true);
    } finally {
      killBackground({ stateDir: ctx.stateDir, id: ctx.ticket.id, role: 'verifier' });
      killBackground({ stateDir: ctx.stateDir, id: ctx.ticket.id, role: 'coder' });
    }
  });
}
