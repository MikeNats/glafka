// Everything a ticket owns: worktree, branch, ports, .env.glafka, and
// whatever setupCmd made. Taken and given back together.
//
// Split across resources/ports.ts, resources/isolationHooks.ts,
// resources/ticketEnv.ts, resources/acquire.ts, resources/release.ts
// and devServer.ts. Re-exported from here so every existing importer
// keeps working unchanged.
export * from './resources/ports.js';
export * from './resources/isolationHooks.js';
export * from './resources/ticketEnv.js';
export * from './resources/acquire.js';
export * from './resources/release.js';
export * from './devServer.js';
