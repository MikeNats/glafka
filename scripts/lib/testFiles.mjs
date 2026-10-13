import { readdirSync } from 'node:fs';
import path from 'node:path';

// We build the test file list ourselves. Node's own search misses
// .test.ts files here, and drops them without a word.
export function listTestFiles(dir = 'test') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTestFiles(full));
    else if (/\.test\.(js|ts)$/.test(entry.name)) out.push(full);
  }
  return out;
}

// Which files are slow, for select-fast-tests.mjs to skip. A set, not an order:
// running them first was measured and deleted.
export const SLOW_SUITES = [
  'test/commands/epistle.test', // 48.1s
  'test/commands/ergonReview.test', // 46.9s
  'test/guardrails/cli.test', // 38.3s
  'test/commands/lysis.test', // 37.5s
  'test/guardrails/sandbox.test', // 36.8s
  'test/guardrails/hook.test', // 32.5s
  'test/guardrails/vendoredHook.test', // installs glafka for real, twice
  'test/commands/uxDefects2.test', // 31.8s
  'test/commands/vima.test', // 28.9s
  'test/commands/ergonBackground.test', // 24.4s
  'test/commands/ergonReviewBackground.test', // 18.2s
  'test/commands/phaseFlow.test', // 17.5s
  'test/ticket/resources.test', // 16.9s
  'test/guardrails/installHook.test', // 14.9s
  'test/util/git.test', // 14.8s
  'test/commands/genesis.test', // 14.6s
  'test/commands/poreia.test', // 13.1s
  'test/commands/ergon.test', // 10.3s
  'test/ticket/ticketStore.test', // 10.1s
];

const slow = new Set(SLOW_SUITES);

function isSlow(file) {
  return slow.has(file.replace(/\.(js|ts)$/, ''));
}

export function withoutSlowSuites(files) {
  return files.filter((file) => !isSlow(file));
}
