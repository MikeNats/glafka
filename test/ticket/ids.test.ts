import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TICKET_ID_RE, assertValidTicketId, buildTicketId } from '../../src/ticket/ids.js';
import { createTicket } from '../../src/commands/genesis/genesis.js';
import { makeTempDir } from '../helpers/tempDir.js';
import { ticketFiles, ticketsDir, closedTicketsDir } from '../../src/ticket/paths.js';

const AUG_7 = new Date('2026-08-07T12:00:00Z');

test('an id is the date and the idea, readable at a glance', () => {
  assert.equal(
    buildTicketId('Add dark mode to settings', { now: AUG_7 }),
    '2026-08-07-add-dark-mode-to-settings',
  );
});

test('punctuation and repeated spaces collapse to single hyphens', () => {
  assert.equal(
    buildTicketId('Add   dark mode!!  (billing)', { now: AUG_7 }),
    '2026-08-07-add-dark-mode-billing',
  );
});

test('a very long idea is cut, and never ends on a hyphen', () => {
  const id = buildTicketId('a'.repeat(200), { now: AUG_7 });

  assert.equal(TICKET_ID_RE.test(id!), true);
  assert.equal(id!.endsWith('-'), false);
  assert.equal(id!.length <= 51, true);
});

test('an idea with no usable characters produces nothing, rather than a bare date', () => {
  // Another alphabet, emoji and punctuation all slug to empty.
  // A bare date is not a name.
  assert.equal(buildTicketId('!!! ???', { now: AUG_7 }), null);
  assert.equal(buildTicketId('φτιάξε το σύστημα', { now: AUG_7 }), null);
  assert.equal(buildTicketId('🔥🔥🔥', { now: AUG_7 }), null);
});

test('an idea in mixed alphabets keeps the part that can be used', () => {
  // Only the letters a-z survive, so a Greek sentence about "login" is named
  // after the one word that made it through.
  assert.equal(buildTicketId('φτιάξε το login', { now: AUG_7 }), '2026-08-07-login');
});

test('the old format is not an id any more', () => {
  assert.equal(TICKET_ID_RE.test('t-57faff1d'), false); // invalid now
  assert.throws(() => assertValidTicketId('t-57faff1d'), /invalid ticket id/);
});

test('nothing that could escape a directory is an id', () => {
  for (const bad of [
    '../etc/passwd',
    '2026-08-07-a/../../b',
    '2026-08-07-a/b',
    '2026-08-07-..',
    '/2026-08-07-a',
    '2026-08-07-A-UPPER',
    '2026-8-7-short-date',
    'fix-login-bypass',
    '2026-08-07-',
    '2026-08-07',
  ]) {
    assert.equal(TICKET_ID_RE.test(bad), false, bad);
  }
});

test('a real id passes', () => {
  assert.equal(TICKET_ID_RE.test('2026-08-07-add-dark-mode-to-settings'), true);
});

// -------------------------------------------------------------------------- Creating a ticket under its name

test('a ticket is created under its readable name', () => {
  const stateDir = makeTempDir('state');
  const repoRoot = makeTempDir('repo');
  const ticket = createTicket({ stateDir, repoRoot, content: 'Add dark mode to settings' });

  assert.match(ticket.id, /^\d{4}-\d{2}-\d{2}-add-dark-mode-to-settings$/);
  assert.equal(fs.existsSync(ticketFiles(ticketsDir(stateDir), ticket.id).ticketFile), true);
});

test('the same idea twice on the same day is refused, and says what holds the name', () => {
  const stateDir = makeTempDir('state');
  const repoRoot = makeTempDir('repo');
  createTicket({ stateDir, repoRoot, content: 'Fix the login bug' });

  assert.throws(
    () => createTicket({ stateDir, repoRoot, content: 'Fix the login bug' }),
    (err: Error) => {
      assert.match(err.message, /already/);
      // Naming the id is what makes the refusal actionable.
      assert.match(err.message, /fix-the-login-bug/);
      return true;
    },
  );
});

test('an idea with no usable characters is refused with a way out', () => {
  const stateDir = makeTempDir('state');
  const repoRoot = makeTempDir('repo');

  assert.throws(() => createTicket({ stateDir, repoRoot, content: 'φτιάξε το σύστημα' }), /--name/);
});

test('--name overrides the idea when the idea will not slug', () => {
  const stateDir = makeTempDir('state');
  const repoRoot = makeTempDir('repo');
  const ticket = createTicket({
    stateDir,
    repoRoot,
    content: 'φτιάξε το σύστημα',
    name: 'fix the system',
  });

  assert.match(ticket.id, /^\d{4}-\d{2}-\d{2}-fix-the-system$/);
  // The idea itself is untouched — it is what the ticket is about.
  assert.equal(ticket.specText, 'φτιάξε το σύστημα');
});

test('a closed ticket still holds its name', () => {
  const stateDir = makeTempDir('state');
  const repoRoot = makeTempDir('repo');
  const ticket = createTicket({ stateDir, repoRoot, content: 'Fix the login bug' });
  // Closing moves the file to tickets/closed/. The name must stay taken.
  const to = ticketFiles(closedTicketsDir(stateDir), ticket.id);
  fs.mkdirSync(path.dirname(to.dir), { recursive: true });
  fs.renameSync(ticketFiles(ticketsDir(stateDir), ticket.id).dir, to.dir);

  assert.throws(
    () => createTicket({ stateDir, repoRoot, content: 'Fix the login bug' }),
    /already/,
  );
});

test('a worktree or a spec already under the name holds it too', () => {
  const stateDir = makeTempDir('state');
  const repoRoot = makeTempDir('repo');
  const id = buildTicketId('Fix the login bug')!;
  fs.mkdirSync(path.join(repoRoot, '.worktrees', id), { recursive: true });

  assert.throws(
    () => createTicket({ stateDir, repoRoot, content: 'Fix the login bug' }),
    /worktree/,
  );
});

// -------------------------------------------------------------------------- The old format must not creep back

// A fixture id that stops matching TICKET_ID_RE turns its test into a no-op
// that still passes, so nothing may quietly go back to the old shape.
test('no test uses the old ticket-id format, except to prove it is invalid', () => {
  const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const offenders: string[] = [];

  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      const lines = fs.readFileSync(full, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!/['"`]t-[0-9a-zA-Z]/.test(line)) return;
        // Deliberate invalid ids are the one legitimate use left.
        if (/BAD_IDS|invalid|not an id/i.test(line)) return;
        offenders.push(`${path.relative(repoRoot, full)}:${i + 1}`);
      });
    }
  };
  walk(path.join(repoRoot, 'test'));

  assert.deepEqual(offenders, []);
});
