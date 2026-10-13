import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeGitRepo } from '../helpers/gitFixture.js';
import { heureka } from '../../src/commands/heureka/heureka.js';
import { ergonReview } from '../../src/commands/ergon/ergon.js';
import { lysis } from '../../src/commands/lysis/lysis.js';
import { readTicket, isActive, isClosed } from '../../src/ticket/ticketStore.js';
import { promoteEthosCandidates } from '../../src/memory/ethos.js';
import { architectureIndexPath, proorismosPath, writeDoc } from '../../src/memory/docsStore.js';
import { makeTempDir } from '../helpers/tempDir.js';

function tempStateDir() {
  return makeTempDir('state');
}

test(
  'heureka opens a real ticket, same as genesis, from just an idea',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();

    const { ticket } = await heureka({ repoRoot, stateDir, idea: 'maybe a caching layer?' });

    assert.equal(isActive(ticket), true);
    assert.equal(fs.existsSync(ticket.worktree!), true);
    assert.equal(typeof ticket.port, 'number'); // check a port was still reserved
    assert.equal(readTicket(stateDir, ticket.id).specText, 'maybe a caching layer?');
  },
);

test(
  "heureka's prompt has no plan section and says to explore instead",
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();

    const { prompt, ticket } = await heureka({
      repoRoot,
      stateDir,
      idea: 'maybe a caching layer?',
    });

    assert.match(prompt, new RegExp(ticket.id));
    assert.match(prompt, /## The idea\nmaybe a caching layer\?/);
    assert.match(prompt, /No fixed plan to follow/);
    assert.doesNotMatch(prompt, /## Plan/);
  },
);

// The agent already reads AGENTS.md and CLAUDE.md on its own.
test(
  "heureka does NOT embed this project's AGENTS.md — the agent reads it itself",
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    // Commit it to the base branch, so the new worktree starts with it.
    fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), 'use uv for dependencies\n');
    execFileSync('git', ['add', 'AGENTS.md'], { cwd: repoRoot });
    execFileSync('git', ['commit', '-q', '-m', 'add AGENTS.md'], { cwd: repoRoot });

    const { prompt } = await heureka({ repoRoot, stateDir, idea: 'task' });

    assert.doesNotMatch(prompt, /## Project memory/);
    assert.doesNotMatch(prompt, /use uv for dependencies/);
  },
);

test(
  'heureka includes the active persona when one is passed in',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();

    const { prompt } = await heureka({
      repoRoot,
      stateDir,
      idea: 'task',
      personaContent: '- lead with what if\n- start from the user',
    });

    assert.match(prompt, /## Persona/);
    assert.match(prompt, /lead with what if/);
  },
);

test(
  'heureka includes accumulated ethos conventions when they exist',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    promoteEthosCandidates(repoRoot, [{ target: 'ETHOS_CODE', text: 'prefer composition' }]);

    const { prompt } = await heureka({ repoRoot, stateDir, idea: 'task' });

    assert.match(prompt, /## Project rules/);
    assert.match(prompt, /prefer composition/);
  },
);

test(
  "heureka includes the project's destination once someone has written one",
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    writeDoc(proorismosPath(repoRoot), 'Become the default tool for X.\n');

    const { prompt } = await heureka({ repoRoot, stateDir, idea: 'task' });

    assert.match(prompt, /## Destination/);
    assert.match(prompt, /Become the default tool for X\./);
  },
);

test(
  "heureka includes odysse's architecture index once it has been run",
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    writeDoc(architectureIndexPath(repoRoot), '# Architecture\n\n- src/commands/ — CLI commands\n');

    const { prompt } = await heureka({ repoRoot, stateDir, idea: 'task' });

    assert.match(prompt, /## Codebase map/);
    assert.match(prompt, /src\/commands\/ — CLI commands/);
  },
);

test(
  "heureka's ticket runs through ergon's review step and lysis exactly like any other ticket",
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const { ticket } = await heureka({ repoRoot, stateDir, idea: 'maybe a caching layer?' });
    fs.writeFileSync(path.join(ticket.worktree!, 'cache.js'), 'export const cache = new Map();\n');
    execFileSync('git', ['add', 'cache.js'], { cwd: ticket.worktree! });
    execFileSync('git', ['commit', '-q', '-m', 'prototype a cache'], { cwd: ticket.worktree! });

    const reviewed = await ergonReview({ stateDir, id: ticket.id, repoRoot, baseRef: 'main' });
    assert.match(reviewed.diff, /cache\.js/);
    assert.match(reviewed.prompt, /maybe a caching layer\?/);

    const closed = await lysis({ repoRoot, stateDir, id: ticket.id });
    assert.equal(isClosed(closed), true);
  },
);
