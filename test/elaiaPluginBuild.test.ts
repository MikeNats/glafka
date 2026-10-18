import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = path.join(ROOT, 'dist', 'elaia-plugin', 'plugin.cjs');

test('one glafka install gives the glafka-elaia command too', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.bin['glafka-elaia'], './dist/elaia-plugin/plugin.cjs');
  assert.ok(fs.readFileSync(PLUGIN, 'utf8').startsWith('#!/usr/bin/env node'));
});

// The built file runs on its own, libraries inside: it answers an MCP hello.
test('the built glafka-elaia answers as an MCP server', async () => {
  const child = spawn(process.execPath, [PLUGIN], { stdio: ['pipe', 'pipe', 'inherit'] });
  const hello = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 't', version: '1' },
    },
  };
  child.stdin.write(`${JSON.stringify(hello)}\n`);
  const line = await new Promise<string>((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes('\n')) resolve(out.split('\n')[0]!);
    });
    child.on('error', reject);
    setTimeout(() => reject(new Error(`no answer: ${out}`)), 10_000).unref();
  });
  child.kill();
  const answer = JSON.parse(line);
  assert.equal(answer.id, 1);
  assert.ok(answer.result.serverInfo.name);
});
