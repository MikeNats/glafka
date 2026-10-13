import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeGitRepo } from '../helpers/gitFixture.js';
import { makeTempDir } from '../helpers/tempDir.js';
import { createTicket } from '../../src/commands/genesis/genesis.js';
import { runApofasi } from '../../installKit/bin/commands/apofasi.js';
import { readDecisions } from '../../src/ticket/decisions.js';

test('a real terminal writes under Person decisions', () => {
  const repoRoot = makeGitRepo();
  const stateDir = makeTempDir('state');
  const ticket = createTicket({ repoRoot, stateDir, content: 'task' });

  runApofasi({ args: [ticket.id, 'no', 'lat/lon', 'input'], stateDir, hasTty: () => true });

  const text = readDecisions(stateDir, ticket.id)!;
  const personBlock = text.slice(
    text.indexOf('## Person decisions'),
    text.indexOf('## Coder decisions'),
  );
  assert.match(personBlock, /no lat\/lon input/);
});

test('no terminal writes under Coder decisions', () => {
  const repoRoot = makeGitRepo();
  const stateDir = makeTempDir('state');
  const ticket = createTicket({ repoRoot, stateDir, content: 'task' });

  runApofasi({
    args: [ticket.id, 'chose', 'Map', 'over', 'object'],
    stateDir,
    hasTty: () => false,
  });

  const text = readDecisions(stateDir, ticket.id)!;
  const coderBlock = text.slice(text.indexOf('## Coder decisions'));
  assert.match(coderBlock, /chose Map over object/);
  assert.doesNotMatch(
    text.slice(text.indexOf('## Person decisions'), text.indexOf('## Coder decisions')),
    /chose Map over object/,
  );
});

test('an id with no text is refused', () => {
  const repoRoot = makeGitRepo();
  const stateDir = makeTempDir('state');
  const ticket = createTicket({ repoRoot, stateDir, content: 'task' });

  assert.throws(
    () => runApofasi({ args: [ticket.id], stateDir, hasTty: () => true }),
    /usage: glafka apofasi/,
  );
});

test('no id at all is refused', () => {
  const stateDir = makeTempDir('state');
  assert.throws(
    () => runApofasi({ args: [], stateDir, hasTty: () => true }),
    /usage: glafka apofasi/,
  );
});
