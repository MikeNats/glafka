import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeGitRepo } from '../helpers/gitFixture.js';
import { makeTempDir } from '../helpers/tempDir.js';
import { genesis, createTicket } from '../../src/commands/genesis/genesis.js';
import { updateTicket } from '../../src/ticket/ticketStore.js';
import { resolveTicketId } from '../../src/ticket/resolve.js';

test('cwd inside a worktree wins, even from a nested folder', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = makeTempDir('state');
  const ticket = await genesis({ repoRoot, stateDir, content: 'task' });

  const nested = path.join(repoRoot, '.worktrees', ticket.id, 'src', 'deep');
  fs.mkdirSync(nested, { recursive: true });

  assert.equal(resolveTicketId({ stateDir, repoRoot, cwd: nested }), ticket.id);
});

test('a single open ticket is used when cwd and branch say nothing', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = makeTempDir('state');
  const ticket = await genesis({ repoRoot, stateDir, content: 'task' });

  assert.equal(resolveTicketId({ stateDir, repoRoot, cwd: repoRoot }), ticket.id);
});

test('two open tickets and no other signal errors, naming both ids', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = makeTempDir('state');
  const first = await genesis({ repoRoot, stateDir, content: 'first task' });
  const second = await genesis({ repoRoot, stateDir, content: 'second task' });

  assert.throws(
    () => resolveTicketId({ stateDir, repoRoot, cwd: repoRoot }),
    (err: Error) => err.message.includes(first.id) && err.message.includes(second.id),
  );
});

test('no open tickets errors without naming a ticket', () => {
  const repoRoot = makeGitRepo();
  const stateDir = makeTempDir('state');

  assert.throws(() => resolveTicketId({ stateDir, repoRoot, cwd: repoRoot }), /no open tickets/);
});

test('a folder under .worktrees that is not a ticket id is ignored', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = makeTempDir('state');
  const ticket = await genesis({ repoRoot, stateDir, content: 'task' });

  const stray = path.join(repoRoot, '.worktrees', 'scratch');
  fs.mkdirSync(stray, { recursive: true });

  // Falls through to the single-open-ticket rule rather than returning "scratch".
  assert.equal(resolveTicketId({ stateDir, repoRoot, cwd: stray }), ticket.id);
});

test('the branch names the ticket when the cwd says nothing', () => {
  const repoRoot = makeGitRepo();
  const stateDir = makeTempDir('state');
  const onBranch = createTicket({ repoRoot, stateDir, content: 'first task' });
  createTicket({ repoRoot, stateDir, content: 'second task' });
  // The fixture repo is on "main", so this ticket is the one being worked on.
  updateTicket(stateDir, onBranch.id, () => ({ branch: 'main' }));

  // Two open tickets, so only the branch can decide between them.
  assert.equal(resolveTicketId({ stateDir, repoRoot, cwd: repoRoot }), onBranch.id);
});

test('a branch shared by no ticket falls through to the open list', () => {
  const repoRoot = makeGitRepo();
  const stateDir = makeTempDir('state');
  const only = createTicket({ repoRoot, stateDir, content: 'only task' });

  assert.equal(resolveTicketId({ stateDir, repoRoot, cwd: repoRoot }), only.id);
});
