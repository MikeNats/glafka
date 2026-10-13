#!/usr/bin/env node
// A quick test run for everyday coding. The full suite takes a few
// minutes because some tests really do run git, the CLI, or a sandbox.
// Always run the full suite before committing. This is just for in between.
//
// Do not rename this file to start with "test-" or end in "-test.mjs".
// Node would then try to run this file itself as a test, which breaks things.
import { spawnSync } from 'node:child_process';
import { listTestFiles, withoutSlowSuites } from './lib/testFiles.mjs';
import { reportElapsed } from './lib/elapsed.mjs';
import { testEnv } from './lib/testEnv.mjs';

const files = withoutSlowSuites(listTestFiles());

const result = reportElapsed('fast suite', () =>
  spawnSync('node', ['--import', 'tsx', '--test', '--test-concurrency=8', ...files], {
    stdio: 'inherit',
    env: testEnv(),
  }),
);
process.exitCode = result.status ?? 1;
