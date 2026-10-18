// One file Elaia can run: dist/plugin.cjs (the `glafka-elaia` command).
import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/plugin.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'info',
});
