import type { Policy } from '../types/policy.js';
import type { Action } from '../types/action.js';
import type { Decision } from '../types/decision.js';
import type { LayerMeta } from '../types/layer.js';
import type { Env } from '../types/env.js';
import { commandName } from './exec.js';

// LAYER: network — checks connections going out. It is weak at level 3, because a script gets past it. It is only real at level 4, in the sandbox.

export const meta: LayerMeta = {
  name: 'network',
  kind: 'doorman at level 3, wall at level 4',
  rung: 1,
  what: 'limits which hosts the agent can reach',
  beatenBy: 'any library call, unless mode is none inside a sandbox',
};

// Commands that use the network. This only catches the obvious ones.
const NET_COMMANDS = ['curl', 'wget', 'nc', 'telnet', 'ssh', 'scp', 'rsync', 'ftp'];

// The host part of a URL, or null if we can not read it.
function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function check(policy: Policy, action: Action): Decision {
  const cfg = policy.network;
  if (!cfg.enabled || cfg.mode === 'open') {
    return { allow: true, reason: 'network layer off' };
  }

  // A built-in fetch tool. We used to check commands only,
  // so these went out without this layer ever seeing them.
  if (action.op === 'fetch') {
    const url = 'url' in action ? action.url : null;
    if (cfg.mode === 'none') {
      return { allow: false, reason: 'this level allows no network at all' };
    }
    const host = url ? hostOf(url) : null;
    if (!host) {
      return {
        allow: false,
        reason: 'a fetch with no readable URL — refusing rather than guessing',
      };
    }
    if (!cfg.allowHosts.includes(host)) {
      return { allow: false, reason: `host not on the allow list: ${host}` };
    }
    return { allow: true, reason: 'host allowed', weak: true };
  }

  const argv = ('argv' in action ? action.argv : undefined) ?? [];
  if (argv.length === 0) return { allow: true, reason: 'no command to inspect' };

  // Lowercased for this lookup only. Windows filenames are case-insensitive, so `WGET.EXE` is a real
  // way to run wget; on a deny list, folding case can only ever match MORE, never let something through.
  const name = commandName(argv[0]).toLowerCase();
  if (!name || !NET_COMMANDS.includes(name)) {
    return { allow: true, reason: 'not a network command' };
  }

  if (cfg.mode === 'none') {
    return { allow: false, reason: `${name} blocked — this level allows no network` };
  }

  // Allow list mode. Every argument that could be a target is resolved the same way the fetch
  // branch above does, and anything unresolvable is REFUSED, not dropped. The old regex demanded a
  // dotted TLD, so a raw IP, an IPv6 literal and `host:port` all matched nothing, left `hosts`
  // empty, and reported "host allowed".
  const targets = argv.slice(1).filter((arg) => !arg.startsWith('-'));
  if (targets.length === 0) {
    return {
      allow: false,
      reason: `${name} with no readable target — refusing rather than guessing where it points`,
    };
  }

  for (const target of targets) {
    const host = hostOfTarget(target);
    if (host === null) {
      return {
        allow: false,
        reason: `${name} was given a target this layer cannot read (${target}) — refusing rather than assuming it is allowed`,
      };
    }
    // An IP literal is only ever allowed spelled exactly as the list spells it:
    // it names no domain, so nothing can be checked about where it really goes.
    if (!cfg.allowHosts.includes(host)) {
      return { allow: false, reason: `host not on the allow list: ${host}` };
    }
  }
  return { allow: true, reason: 'host allowed', weak: true };
}

// The host a command-line argument points at. Handles `https://h/p`, bare `h`, `h:port`,
// `user@h:path` (scp/rsync) and IP literals. Null when the argument names no host we can identify —
// which the caller must treat as a refusal, not as "no host to check".
export function hostOfTarget(target: string): string | null {
  // scp/rsync's `user@host:path`, which is not a URL at all.
  const scpLike = target.match(/^[\w.-]+@([^:/]+):/);
  if (scpLike) return scpLike[1]!.toLowerCase();

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(target) ? target : `http://${target}`;
  try {
    const { hostname } = new URL(withScheme);
    if (!hostname) return null;
    // new URL keeps IPv6 in brackets; the allow list would spell it plainly.
    return hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return null;
  }
}

// Proxy settings for allow list mode. They only do something if you point
// GLAFKA_PROXY_URL at a real filtering proxy. We do not ship one.
export function proxyEnv(policy: Policy, sourceEnv: Env = process.env): Record<string, string> {
  const cfg = policy.network;
  if (!cfg.enabled || cfg.mode !== 'allowlist') return {};

  const proxy = sourceEnv.GLAFKA_PROXY_URL;
  if (!proxy) return {};

  return {
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy,
    NO_PROXY: 'localhost,127.0.0.1',
  };
}

export function describe(policy: Policy, sourceEnv: Env = process.env): string[] {
  const cfg = policy.network;
  if (!cfg.enabled || cfg.mode === 'open') {
    return ['open — no host limit (fine if secrets are out of the room)'];
  }
  if (cfg.mode === 'none') {
    return ['none — real only when sandbox.enabled is true; otherwise advisory'];
  }
  const proxied = Boolean(sourceEnv.GLAFKA_PROXY_URL);
  return [
    `allow list (${cfg.allowHosts.length}): ${cfg.allowHosts.join(' · ')}`,
    proxied
      ? '  enforced through GLAFKA_PROXY_URL'
      : '  ADVISORY ONLY — no GLAFKA_PROXY_URL set, so nothing enforces this',
  ];
}
