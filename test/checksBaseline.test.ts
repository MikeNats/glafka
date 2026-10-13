import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDir } from './helpers/tempDir.js';

import {
  readBaseline,
  writeBaseline,
  recordBaseline,
  splitFailures,
} from '../src/checksBaseline.js';
import type { CheckResult } from '../src/types/checks.js';

// glafka guesses lint/typecheck/test off package.json when
// nothing is configured. A guessed check that was ALREADY red on the base commit used to send the coder back three times, at real cost, to fix a script it never wrote.

const COMMIT = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

function tempDir(prefix: string): string {
  return makeTempDir(prefix);
}

function npmProject(scripts: Record<string, string>): string {
  const dir = tempDir('baseline-proj');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts }));
  return dir;
}

function check(name: string, passed: boolean, unknown = false): CheckResult {
  return { name, passed, output: '', ...(unknown ? { unknown: true } : {}) } as CheckResult;
}

// --------------------------------------------------------------------------- splitFailures

test('with no baseline every failure counts as introduced', () => {
  const split = splitFailures([check('test', false), check('lint', true)], null);
  assert.deepEqual(split.introduced, ['test']);
  assert.deepEqual(split.preExisting, []);
});

test('a failure the base commit already had is not this branch to answer for', () => {
  const baseline = { commit: COMMIT, failing: ['lint'], at: '2026-01-01T00:00:00.000Z' };
  const split = splitFailures([check('lint', false), check('test', false)], baseline);

  assert.deepEqual(split.introduced, ['test'], 'test is new, so the coder owns it');
  assert.deepEqual(split.preExisting, ['lint'], 'lint was already red before this ticket');
});

test('a check that could not run is neither introduced nor pre-existing', () => {
  const split = splitFailures([check('test', false, true)], null);
  assert.deepEqual(split.introduced, []);
  assert.deepEqual(split.preExisting, []);
});

// --------------------------------------------------------------------------- read/write

test('a baseline round-trips, and an unknown commit reads as null', () => {
  const stateDir = tempDir('baseline-state');
  assert.equal(readBaseline(stateDir, COMMIT), null);

  writeBaseline(stateDir, { commit: COMMIT, failing: ['test'], at: '2026-01-01T00:00:00.000Z' });

  assert.deepEqual(readBaseline(stateDir, COMMIT)!.failing, ['test']);
  assert.equal(readBaseline(stateDir, 'b'.repeat(40)), null);
});

// A baseline is an optimisation. Corrupt means "unknown", which is the safe
// answer — it falls back to treating every failure as the coder's.
test('a corrupt baseline reads as null instead of throwing', () => {
  const stateDir = tempDir('baseline-corrupt');
  fs.mkdirSync(path.join(stateDir, 'baselines'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'baselines', `${COMMIT}.json`), '{ not json');

  assert.equal(readBaseline(stateDir, COMMIT), null);
});

// The path is built from the value, so anything that is not a sha is refused
// rather than trusted.
test('a commit that is not a sha never becomes a path', () => {
  const stateDir = tempDir('baseline-path');
  assert.equal(readBaseline(stateDir, '../../etc/passwd'), null);
  assert.throws(
    () => writeBaseline(stateDir, { commit: '../../x', failing: [], at: 'now' }),
    /not a commit sha/,
  );
});

// --------------------------------------------------------------------------- recordBaseline

test('recordBaseline records which guessed checks were already failing', async () => {
  const stateDir = tempDir('baseline-record');
  const cwd = npmProject({ lint: 'l', test: 't' });

  // lint is red on the base commit; test is green.
  const baseline = await recordBaseline({
    stateDir,
    worktree: cwd,
    commit: COMMIT,
    checksCmd: null,
    run: (_file, args) => {
      if (args.includes('lint')) throw Object.assign(new Error('failed'), { stdout: 'boom' });
      return 'ok';
    },
  });

  assert.deepEqual(baseline!.failing, ['lint']);
  assert.deepEqual(readBaseline(stateDir, COMMIT)!.failing, ['lint']);
});

// A configured checksCmd is the project's own command. A failure there is real
// and the coder should fix it, so there is nothing to be careful about.
test('recordBaseline does nothing when checksCmd is configured', async () => {
  const stateDir = tempDir('baseline-configured');
  const cwd = npmProject({ test: 't' });
  let ran = false;

  const baseline = await recordBaseline({
    stateDir,
    worktree: cwd,
    commit: COMMIT,
    checksCmd: 'npm test',
    run: () => {
      ran = true;
      return 'ok';
    },
  });

  assert.equal(baseline, null);
  assert.equal(ran, false, 'no checks may run just to take a baseline');
  assert.equal(readBaseline(stateDir, COMMIT), null);
});

// Cached per commit, so ten tickets cut from the same base pay for one run.
test('recordBaseline does not re-run for a commit it already has', async () => {
  const stateDir = tempDir('baseline-cached');
  const cwd = npmProject({ test: 't' });
  writeBaseline(stateDir, { commit: COMMIT, failing: [], at: '2026-01-01T00:00:00.000Z' });
  let ran = false;

  await recordBaseline({
    stateDir,
    worktree: cwd,
    commit: COMMIT,
    checksCmd: null,
    run: () => {
      ran = true;
      return 'ok';
    },
  });

  assert.equal(ran, false);
});

// Nothing to guess about. An empty baseline would claim the base is green
// while having run nothing at all.
test('recordBaseline writes nothing when there are no scripts to guess', async () => {
  const stateDir = tempDir('baseline-empty');
  const cwd = npmProject({});

  const baseline = await recordBaseline({
    stateDir,
    worktree: cwd,
    commit: COMMIT,
    checksCmd: null,
  });

  assert.equal(baseline, null);
  assert.equal(readBaseline(stateDir, COMMIT), null);
});

// Never fail a ticket because the baseline could not be taken.
test('recordBaseline swallows its own errors', async () => {
  const stateDir = tempDir('baseline-throws');
  const cwd = npmProject({ test: 't' });

  const baseline = await recordBaseline({
    stateDir,
    worktree: cwd,
    commit: COMMIT,
    checksCmd: null,
    run: () => {
      throw Object.assign(new Error('spawn failed'), { code: 'ENOENT' });
    },
  });

  // A spawn failure is a failing check, not a crash — but either way the
  // ticket must still be provisioned.
  assert.ok(baseline === null || Array.isArray(baseline.failing));
});

// --------------------------------------------------------------------------- the loop it closes

// The whole point: PreExistingChecksError is NOT a CoderFixableError, because
// vima routes that one straight to a fresh paid coder run.
test('a pre-existing failure is not routed to the coder', async () => {
  const { CoderFixableError, PreExistingChecksError } =
    await import('../src/commands/ergon/ergon.js');
  const err = new PreExistingChecksError('already red');

  assert.equal(err instanceof CoderFixableError, false, 'must never reach spawnCoder');
  assert.equal(err instanceof Error, true);
  assert.equal(err.name, 'PreExistingChecksError');
});

// The heartbeat re-stamps a provisioning lock, so it must fire only when the baseline really spends
// time. Stamping it for a no-op would make an idle provision look busy.
test('the heartbeat fires only when checks are really about to run', async () => {
  const withScripts = npmProject({ test: 't' });
  const withoutScripts = npmProject({});
  const beats: string[] = [];

  await recordBaseline({
    stateDir: tempDir('beat-a'),
    worktree: withoutScripts,
    commit: COMMIT,
    checksCmd: null,
    heartbeat: () => beats.push('no-scripts'),
  });
  await recordBaseline({
    stateDir: tempDir('beat-b'),
    worktree: withScripts,
    commit: COMMIT,
    checksCmd: 'npm test',
    heartbeat: () => beats.push('configured'),
  });
  await recordBaseline({
    stateDir: tempDir('beat-c'),
    worktree: withScripts,
    commit: COMMIT,
    checksCmd: null,
    run: () => 'ok',
    heartbeat: () => beats.push('runs'),
  });

  assert.deepEqual(beats, ['runs']);
});
