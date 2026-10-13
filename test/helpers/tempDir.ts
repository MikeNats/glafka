import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Tests used to call fs.mkdtempSync(os.tmpdir(), ...) directly and never delete
// what they made. One full suite run left about 5,000 directories behind, and
// they built up in /var/folders until the disk was full: 252,507 of them, 15GB.
// It also got slower as it went, because every new fixture had to create an
// entry in a directory that already held a quarter of a million of them.
//
// So every temp directory a test makes now lives under one root per test
// process, and that root is removed when the process exits. Child processes a
// test spawns inherit TMPDIR, so their temp files land inside the root too.
const root = fs.mkdtempSync(path.join(os.tmpdir(), `glafka-run-${process.pid}-`));

// Anything we spawn writes into our root rather than the shared temp dir.
process.env.TMPDIR = root;

let cleaned = false;

function cleanup(): void {
  if (cleaned) return;
  cleaned = true;
  fs.rmSync(root, { recursive: true, force: true });
}

process.on('exit', cleanup);

// 'exit' does not fire on a signal, and Ctrl-C part way through a slow suite is
// the normal way to stop it. Re-raise afterwards so the exit code stays honest.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    cleanup();
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  });
}

// A temp directory that cleans itself up. `prefix` is a short name for what the
// directory holds, so a leftover root is still readable while debugging.
export function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(root, `${prefix}-`));
}

// Where this process keeps its temp directories. Tests that need to assert on
// the real path can use this instead of reaching for os.tmpdir().
export function tempRoot(): string {
  return root;
}
