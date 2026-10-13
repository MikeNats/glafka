import * as filesystem from './layers/filesystem.js';
import * as exec from './layers/exec.js';
import * as execFilesystem from './layers/execFilesystem.js';
import * as network from './layers/network.js';
import type { Policy } from './types/policy.js';
import type { Action } from './types/action.js';
import type { Scopes } from './types/scopes.js';
import type { Decision } from './types/decision.js';
import type { LayerMeta } from './types/layer.js';

// Asks every layer that applies. The first "no" wins.

interface Layer {
  meta: LayerMeta;
  check: (policy: Policy, action: Action, scopes: Scopes, cwd?: string) => Decision;
}

// Which layers check which kind of action.
const LAYERS_FOR: Record<string, Layer[]> = {
  read: [filesystem],
  write: [filesystem],
  delete: [filesystem],
  exec: [exec, execFilesystem, network],
  // A tool that reaches out belongs to the network layer,
  // not to the unknown-action rule.
  fetch: [network],
  // Known to touch nothing, so every level lets it through.
  // An empty list here is not the same as an action we do not know.
  noop: [],
};

export function decide(policy: Policy, action: Action, scopes: Scopes, cwd?: string): Decision {
  const layers = LAYERS_FOR[action.op];

  // We have no rule for this kind of action.
  if (!layers) {
    const deny = policy.onUnknownAction === 'deny';
    return {
      allow: !deny,
      layer: null,
      reason: deny
        ? `unknown action "${action.op}" — this level denies what it does not recognise`
        : `unknown action "${action.op}" — this level allows it`,
    };
  }

  let weak = false;

  for (const layer of layers) {
    let result: Decision;
    try {
      result = layer.check(policy, action, scopes, cwd);
    } catch (err) {
      // A crash must never turn into "allowed".
      if (policy.failClosed) {
        return {
          allow: false,
          layer: layer.meta.name,
          reason: `${layer.meta.name} layer failed (${(err as Error).message}) — denying, because failClosed is on`,
        };
      }
      result = {
        allow: true,
        reason: `${layer.meta.name} layer failed: ${(err as Error).message}`,
      };
    }

    if (!result.allow) {
      return { ...result, layer: layer.meta.name };
    }
    if (result.weak) weak = true;
  }

  return { allow: true, layer: null, reason: 'no layer objected', ...(weak ? { weak: true } : {}) };
}

export const layers = { filesystem, exec, execFilesystem, network };
