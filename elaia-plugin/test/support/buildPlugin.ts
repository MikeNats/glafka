import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import type { TestProject } from 'vitest/node';

// Once per test run: the plugin as the program Elaia runs.
export default async function setup(project: TestProject) {
  const dir = mkdtempSync(path.join(tmpdir(), 'glafka-elaia-plugin-'));
  await build({
    entryPoints: ['src/main.ts'],
    outfile: path.join(dir, 'plugin.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    logLevel: 'error',
  });
  project.provide('plugin', path.join(dir, 'plugin.cjs'));
}

declare module 'vitest' {
  export interface ProvidedContext {
    plugin: string;
  }
}
