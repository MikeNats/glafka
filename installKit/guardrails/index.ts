// The main entry point the rest of glafka imports from.

export { resolvePolicy, scopesFor, loadLevel, PROJECT_POLICY_PATH } from './resolve.js';
export { decide, layers } from './enforce.js';
export { explain, explainLayer, LAYER_NAMES } from './explain.js';
export { buildEnv } from './layers/secrets.js';
export { wrap, detect, pickBackend, selfTest } from './layers/sandbox.js';
export { proxyEnv } from './layers/network.js';
export { pinFor, assertUnchanged, repin, currentPin } from './pin.js';
export {
  warning as hostExecWarning,
  scan as hostExecScan,
  blockingScan as hostExecBlocking,
} from './layers/hostexec.js';
export { CURSOR_NO_WRITE_HOOK, cursorHookInstalled } from './harness.js';
export { claimRecordedRecently, clearSessionClaims, sessionTicketId } from './session.js';
export { HOOK_CONFIG_PATHS } from './pin.js';
export { NEVER_REDACTED } from './layers/secrets.js';
export { globToRegExp } from './layers/filesystem.js';
export { read as readGuardrailsLog } from './audit.js';
export * as audit from './audit.js';

// Types the rest of glafka names in its own signatures. Exported here for the same reason the
// functions are: `guardrails/` ships inside this package, and its folder layout is not the surface
// anyone outside it should be depending on.
//
// Schemas under `types/` are NOT re-exported. Importing this file pulls in `core.ts`, which reads
// `src/ticket/paths.js` (a known, accepted back-edge), so a VALUE imported from here
// by anything under `src/types/` closes a cycle and throws at module init. Type-only imports are
// erased and safe; a zod schema is not. Those import the leaf directly, and the lint rule below
// allows exactly that.
export type { Policy } from './types/policy.js';
