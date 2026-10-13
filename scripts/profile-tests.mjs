#!/usr/bin/env node
// Times every test file on its own, so SLOW_SUITES in lib/testFiles.mjs can be
// refreshed from real numbers. A stale list makes the fast suite run slow files.
//
// Output is ready to paste into SLOW_SUITES.
//
// Do not rename this file to start with "test-" or end in "-test.mjs".
// Node would then try to run this file itself as a test, which breaks things.
import { spawn } from 'node:child_process';
import { listTestFiles } from './lib/testFiles.mjs';
import { formatElapsed } from './lib/elapsed.mjs';
import { testEnv } from './lib/testEnv.mjs';

// Same worker count as the real run, so the numbers reflect a real run.
const CONCURRENCY = 8;
// Files quicker than this are noise next to the slow ones, so they stay out
// of the list and just run in whatever order they are found.
const SLOW_THRESHOLD_MS = 10_000;

const files = listTestFiles();
const results = [];
let next = 0;

function timeOne(file) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn('node', ['--import', 'tsx', '--test', file], {
      stdio: 'ignore',
      env: testEnv(),
    });
    child.on('close', (code) => {
      results.push({ file, ms: Date.now() - started, failed: code !== 0 });
      resolve();
    });
  });
}

async function worker() {
  while (next < files.length) await timeOne(files[next++]);
}

const started = Date.now();
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
results.sort((a, b) => b.ms - a.ms);

const failed = results.filter((r) => r.failed);
if (failed.length) {
  console.error(`\n${failed.length} file(s) failed. Timings below are still usable.`);
  for (const r of failed) console.error(`  ${r.file}`);
}

console.log('\nPaste into SLOW_SUITES in scripts/lib/testFiles.mjs:\n');
for (const r of results) {
  if (r.ms < SLOW_THRESHOLD_MS) break;
  console.log(`  '${r.file.replace(/\.(js|ts)$/, '')}', // ${(r.ms / 1000).toFixed(1)}s`);
}

const total = results.reduce((sum, r) => sum + r.ms, 0);
console.log(`\nwork:  ${formatElapsed(total)} across ${results.length} files`);
console.log(`floor: ${formatElapsed(total / CONCURRENCY)} with ${CONCURRENCY} workers`);
console.log(`took:  ${formatElapsed(Date.now() - started)}`);
