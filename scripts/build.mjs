#!/usr/bin/env node
// The build steps after tsc. They used to be a shell one-liner in
// package.json — `mkdir -p … && cp … && chmod +x …` — which meant `npm
// install` could not finish on Windows at all, because `prepare` runs the
// build and cmd.exe has none of those three commands.
//
// Node has all of them and behaves the same everywhere, so the build stops
// being a place where the OS matters.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// The level files are data, not code, so tsc does not emit them.
const levelsSrc = path.join(ROOT, 'installKit', 'guardrails', 'levels');
const levelsDest = path.join(ROOT, 'dist', 'installKit', 'guardrails', 'levels');
fs.mkdirSync(levelsDest, { recursive: true });

let copied = 0;
for (const name of fs.readdirSync(levelsSrc)) {
  if (!name.endsWith('.json')) continue;
  fs.copyFileSync(path.join(levelsSrc, name), path.join(levelsDest, name));
  copied += 1;
}

// Without a level file the whole policy system reads as "no such level".
// Better to fail the build than to ship that.
if (copied === 0) {
  throw new Error(`no level files found in ${levelsSrc} — the build would ship an unusable policy`);
}

// npm writes its own launcher shims on Windows, and chmod is a no-op there.
// Everywhere else the bin needs the bit set or `glafka` cannot be run.
const cli = path.join(ROOT, 'dist', 'installKit', 'bin', 'glafka.js');
if (process.platform !== 'win32' && fs.existsSync(cli)) {
  fs.chmodSync(cli, 0o755);
}

console.log(`build: ${copied} level file(s) copied`);
