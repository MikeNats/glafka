#!/usr/bin/env node
// Runs the full test suite, from a list of files we build ourselves.
import { spawnSync } from 'node:child_process';
import { listTestFiles } from './lib/testFiles.mjs';
import { reportElapsed } from './lib/elapsed.mjs';
import { testEnv } from './lib/testEnv.mjs';

// 8 on an 11-core M3 Pro. Kept because it is what has always been used: the old
// 46s/68s/62s note was single runs, and repeats of one setting ranged 62s-163s.
const CONCURRENCY = 8;

// Directory order. Slow-files-first was tried and measured — see SLOW_SUITES.
const files = listTestFiles();

const result = reportElapsed('full suite', () =>
  spawnSync('node', ['--import', 'tsx', '--test', `--test-concurrency=${CONCURRENCY}`, ...files], {
    stdio: 'inherit',
    env: testEnv(),
  }),
);
process.exitCode = result.status ?? 1;
