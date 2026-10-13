import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shellPath, shellArgv, WINDOWS_BASH_CANDIDATES } from '../../src/util/shell.js';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Everything glafka runs on your behalf is a shell string you wrote once: checksCmd, the agent
// commands, setupCmd, notifyCmd. They must keep meaning the same thing on every machine.

test('a shell command is one file plus -c plus the string, unsplit', () => {
  const argv = shellArgv('npm test && npm run lint');

  assert.equal(argv[1], '-c');
  // The command survives whole. Splitting it here would break every pipe,
  // every && and every quoted argument in someone's config.
  assert.equal(argv[2], 'npm test && npm run lint');
  assert.equal(argv.length, 3);
});

test('GLAFKA_SHELL wins, so a shell in an unusual place can still be used', () => {
  assert.equal(shellPath({ GLAFKA_SHELL: '/opt/weird/bash' }), '/opt/weird/bash');
});

// On this machine (not Windows) it is plain `sh`, exactly as before.
test('on a POSIX host the shell is sh, unchanged', { skip: process.platform === 'win32' }, () => {
  assert.equal(shellPath({}), 'sh');
  assert.deepEqual(shellArgv('echo hi', {}), ['sh', '-c', 'echo hi']);
});

// cmd.exe is refused on purpose. It would not FAIL on a POSIX-shaped checksCmd — it would run it with
// different meaning, and a check that quietly stops checking is worse than one that will not start.
test('every shell glafka will look for on Windows is a POSIX one', () => {
  assert.ok(WINDOWS_BASH_CANDIDATES.length > 0);
  for (const candidate of WINDOWS_BASH_CANDIDATES) {
    assert.match(candidate, /bash\.exe$/i, candidate);
  }
});

// Nothing may go back to spawning a bare `sh`, or Windows breaks again in a
// place nobody looks.
test('no source file spawns a bare sh any more', () => {
  const offenders: string[] = [];

  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (['node_modules', 'dist', '.git', '.worktrees'].includes(entry.name)) continue;
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      // The helper itself names the shells it looks for.
      if (full.endsWith(path.join('src', 'util', 'shell.ts'))) continue;
      const text = fs.readFileSync(full, 'utf8');
      if (/(spawn|execFileSync|execFile|run)\(\s*'sh'/.test(text)) {
        offenders.push(path.relative(REPO_ROOT, full));
      }
    }
  };

  // installKit holds bin/ and guardrails/; the .ts filter skips its docs.
  for (const dir of ['src', 'installKit']) walk(path.join(REPO_ROOT, dir));

  assert.deepEqual(offenders, []);
});
