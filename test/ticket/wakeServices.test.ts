import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { wakeTicketServices } from '../../src/ticket/wakeServices.js';
import { isolationProfilePath } from '../../src/memory/docsStore.js';
import { makeTempDir } from '../helpers/tempDir.js';
import type { Ticket } from '../../src/types/ticket.js';

// setupCmd gives a ticket its own database and then nothing watches it. One died — Exited (255) —
// with nothing to notice or bring it back, and it took a hand-typed `docker start` to recover.

function project(profile: Record<string, unknown> | null): {
  repoRoot: string;
  ticket: Ticket;
} {
  const repoRoot = makeTempDir('wake-repo');
  const worktree = path.join(repoRoot, '.worktrees', 'demo');
  fs.mkdirSync(worktree, { recursive: true });
  if (profile) {
    const profilePath = isolationProfilePath(repoRoot);
    fs.mkdirSync(path.dirname(profilePath), { recursive: true });
    fs.writeFileSync(profilePath, JSON.stringify(profile));
  }
  return {
    repoRoot,
    ticket: { id: '2026-08-08-add-a-widget', worktree } as Ticket,
  };
}

// Records what it was asked to run, instead of running it.
function spy() {
  const calls: { cmd: string; env: Record<string, string>; label?: string }[] = [];
  const run = (cmd: string, options: { env: Record<string, string>; label?: string }) => {
    calls.push({ cmd, env: options.env, label: options.label });
    return {};
  };
  return { calls, run: run as never };
}

test('a configured wakeCmd runs before the coder does', () => {
  const { repoRoot, ticket } = project({ services: [], wakeCmd: 'docker start app-db' });
  const { calls, run } = spy();

  assert.deepEqual(wakeTicketServices({ repoRoot, ticket, run }), { ran: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.cmd, 'docker start app-db');
  assert.equal(calls[0]!.label, 'wakeCmd');
});

// It has to be able to name the very container setupCmd made, which is why it gets
// setupCmd's environment rather than a bare one.
test('wakeCmd gets the ticket id, the paths, and whatever setupCmd left behind', () => {
  const { repoRoot, ticket } = project({ services: [], wakeCmd: 'docker start $GLAFKA_TICKET_ID' });
  fs.writeFileSync(
    path.join(ticket.worktree!, '.env.glafka'),
    'DATABASE_URL=postgresql://localhost:4137/app\n',
  );
  const { calls, run } = spy();

  wakeTicketServices({ repoRoot, ticket, run });

  const { env } = calls[0]!;
  assert.equal(env.GLAFKA_TICKET_ID, '2026-08-08-add-a-widget');
  assert.equal(env.GLAFKA_WORKTREE, ticket.worktree);
  assert.equal(env.GLAFKA_REPO_ROOT, repoRoot);
  assert.equal(env.DATABASE_URL, 'postgresql://localhost:4137/app');
});

test('a project with no wakeCmd runs nothing', () => {
  const { repoRoot, ticket } = project({ services: [], setupCmd: 'true' });
  const { calls, run } = spy();

  assert.deepEqual(wakeTicketServices({ repoRoot, ticket, run }), { ran: false });
  assert.equal(calls.length, 0);
});

test('a project with no isolation profile at all runs nothing', () => {
  const { repoRoot, ticket } = project(null);
  const { calls, run } = spy();

  assert.deepEqual(wakeTicketServices({ repoRoot, ticket, run }), { ran: false });
  assert.equal(calls.length, 0);
});

// A ticket with no worktree has no services of its own yet.
test('a ticket with no worktree runs nothing', () => {
  const { repoRoot } = project({ services: [], wakeCmd: 'docker start app-db' });
  const { calls, run } = spy();

  const ticket = { id: '2026-08-08-add-a-widget', worktree: null } as unknown as Ticket;
  assert.deepEqual(wakeTicketServices({ repoRoot, ticket, run }), { ran: false });
  assert.equal(calls.length, 0);
});

// The point of not swallowing it. A project that configured wakeCmd said this is how its
// services come back; if that fails they are down and staying down, and a coder handed a
// dead database sees its own work failing rather than a dead database.
test('a wakeCmd that fails is not swallowed', () => {
  const { repoRoot, ticket } = project({ services: [], wakeCmd: 'docker start app-db' });
  const run = (() => {
    throw new Error('wakeCmd failed: No such container: app-db');
  }) as never;

  assert.throws(() => wakeTicketServices({ repoRoot, ticket, run }), /No such container/);
});
