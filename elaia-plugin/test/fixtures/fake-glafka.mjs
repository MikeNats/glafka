#!/usr/bin/env node
// A stand-in for glafka. It prints <FAKE_GLAFKA_DIR>/<command>.json and logs every call.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const dir = process.env.FAKE_GLAFKA_DIR;
const [command = 'none', ...rest] = process.argv.slice(2);
appendFileSync(path.join(dir, 'calls.log'), `${process.cwd()}\t${[command, ...rest].join(' ')}\n`);

const writes = path.join(dir, `${command}.writes.json`);
if (existsSync(writes))
  for (const [file, text] of Object.entries(JSON.parse(readFileSync(writes, 'utf8')))) {
    mkdirSync(path.dirname(path.join(process.cwd(), file)), { recursive: true });
    writeFileSync(path.join(process.cwd(), file), text);
  }

const out = path.join(dir, `${command}.json`);
const code = path.join(dir, `${command}.code`);
if (existsSync(out)) process.stdout.write(readFileSync(out, 'utf8'));
else process.stderr.write(`fake glafka: no ${command}.json\n`);
process.exitCode = existsSync(code) ? Number(readFileSync(code, 'utf8')) : existsSync(out) ? 0 : 1;
