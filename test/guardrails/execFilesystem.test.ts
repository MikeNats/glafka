import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../../installKit/guardrails/enforce.js';
import {
  pathArguments,
  gitPathArguments,
} from '../../installKit/guardrails/layers/execFilesystem.js';
import { loadLevel } from '../../installKit/guardrails/resolve.js';

const WORKTREE = '/repo/.worktrees/2026-08-02-cage-the-coder';
const scopes = { TICKET_WORKTREE: WORKTREE, TICKET_SCRATCH: '/tmp/glafka-t-abc12345' };
const OUT = '/Users/someone/.ssh';

function allows(level: number, argv: string[]): boolean {
  return decide(loadLevel(level), { op: 'exec', argv }, scopes, WORKTREE).allow;
}

// The exec layer grants these by NAME, and execFilesystem never looked at
// their paths — so each one reached straight out of the worktree.
for (const level of [2, 3, 4]) {
  test(`level ${level}: untracked path commands cannot reach outside the worktree`, () => {
    for (const argv of [
      ['mkdir', '-p', `${OUT}/evil`],
      ['touch', `${OUT}/authorized_keys`],
      ['ls', '-la', OUT],
      ['rg', 'BEGIN PRIVATE KEY', OUT],
    ]) {
      assert.equal(allows(level, argv), false, argv.join(' '));
    }
  });
}

// `-C` and `-f` name a path that no plain-argument scan would ever see.
for (const level of [2, 3]) {
  test(`level ${level}: make cannot be pointed at a directory or makefile outside`, () => {
    for (const argv of [
      ['make', '-C', '/Users/someone/Dev/other'],
      ['make', '--directory=/Users/someone/Dev/other'],
      ['make', '-f', '/Users/someone/evil.mk'],
      ['make', '--file=/Users/someone/evil.mk'],
      ['make', '-C/Users/someone/Dev/other'],
    ]) {
      assert.equal(allows(level, argv), false, argv.join(' '));
    }
  });
}

// A denial the coder does not deserve is as bad as a hole: it stops the work
// and teaches nobody anything.
test('ordinary use of the newly tracked commands still runs', () => {
  for (const argv of [
    ['mkdir', '-p', 'src/new'],
    ['touch', 'src/new.ts'],
    ['ls', '-la', 'src'],
    ['rg', '-n', 'TODO', 'src/'],
    ['make', 'test'],
    ['make', '-C', 'packages/api', 'build'],
  ]) {
    assert.equal(allows(2, argv), true, argv.join(' '));
  }
});

// For rg the first bare word is the pattern, for make it is the target.
// Treating either as a path would refuse the most ordinary command there is.
test('pathArguments skips the leading pattern or target, and keeps real paths', () => {
  assert.deepEqual(pathArguments('rg', ['-n', 'TODO', 'src/']), ['src/']);
  assert.deepEqual(pathArguments('rg', ['TODO']), []);
  assert.deepEqual(pathArguments('make', ['test']), []);
  assert.deepEqual(pathArguments('make', ['-C', 'pkg', 'build']), ['pkg']);
  assert.deepEqual(pathArguments('cp', ['a.txt', 'b.txt']), ['a.txt', 'b.txt']);
  assert.deepEqual(pathArguments('cat', ['/dev/null']), []);
});

// -t/--target-directory moves the DESTINATION out of its usual
// last-operand position, so the scan saw only the harmless source.
test('the target-directory flag is read as the destination it is', () => {
  assert.deepEqual(pathArguments('cp', ['--target-directory=/etc/cron.d', 'payload']), [
    '/etc/cron.d',
    'payload',
  ]);
  assert.deepEqual(pathArguments('mv', ['-t', '/etc/cron.d', 'payload']), [
    '/etc/cron.d',
    'payload',
  ]);
  assert.deepEqual(pathArguments('install', ['--target-directory=/usr/local/bin', 'x']), [
    '/usr/local/bin',
    'x',
  ]);
  // The joined short form too.
  assert.deepEqual(pathArguments('cp', ['-t/etc/cron.d', 'payload']), ['/etc/cron.d', 'payload']);
});

// git is on exec.allow at every level and was in no path
// table, so its pathspecs were checked by nobody.
test('git pathspecs are read as paths, and refs are not', () => {
  assert.deepEqual(gitPathArguments(['git', 'rm', '.claude/settings.json']), [
    '.claude/settings.json',
  ]);
  assert.deepEqual(gitPathArguments(['git', 'checkout', 'main', '--', 'docs/x.md']), ['docs/x.md']);
  assert.deepEqual(gitPathArguments(['git', 'restore', '--source=main', 'docs/x.md']), [
    'docs/x.md',
  ]);
  assert.deepEqual(gitPathArguments(['git', 'mv', 'junk', '.glafka.json']), [
    'junk',
    '.glafka.json',
  ]);
  // A ref is not a path, and neither is a commit message.
  assert.deepEqual(gitPathArguments(['git', 'checkout', '-b', 'feat']), []);
  assert.deepEqual(gitPathArguments(['git', 'commit', '-m', 'clone']), []);
  assert.deepEqual(gitPathArguments(['git', 'log', 'main..HEAD']), []);
  assert.deepEqual(gitPathArguments(['git', 'rebase', 'main']), []);
});
