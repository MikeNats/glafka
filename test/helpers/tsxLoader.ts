import { createRequire } from 'node:module';

// Temporary, for the TS migration. A spawned node process needs
// `--import tsx` (as a full path) so it can load .ts files.
const require = createRequire(import.meta.url);
export const TSX_LOADER_PATH = require.resolve('tsx');

// Use in argv arrays like: ['node', ...NODE_TSX_ARGS, BIN, ...]
export const NODE_TSX_ARGS = ['--import', TSX_LOADER_PATH];

// Use in shell command strings like: `${NODE_TSX_SHELL_PREFIX} "${BIN}" krisis ...`
export const NODE_TSX_SHELL_PREFIX = `node --import ${JSON.stringify(TSX_LOADER_PATH)}`;
