import { layers } from './enforce.js';
import * as secrets from './layers/secrets.js';
import * as sandbox from './layers/sandbox.js';
import * as hostexec from './layers/hostexec.js';
import { resolvePolicy, scopesFor, PROJECT_POLICY_PATH } from './resolve.js';
import { CURSOR_NO_WRITE_HOOK, cursorHookInstalled } from './harness.js';
import type { ResolvedPolicy } from './resolve.js';
import type { Scopes } from './types/scopes.js';
import type { LayerMeta } from './types/layer.js';

// `glafka guardrails` — shows what is on, and what still gets through.
// Naming the gaps matters as much as naming the protections.

const BAR = '─'.repeat(64);

export function explain({
  repoRoot,
  ticketId = null,
  levelOverride = null,
}: {
  repoRoot: string;
  ticketId?: string | null;
  levelOverride?: number | null;
}): { text: string; resolved: ResolvedPolicy } {
  const resolved = resolvePolicy({ repoRoot, levelOverride });
  const { policy } = resolved;
  const scopes: Scopes | Record<string, never> = ticketId ? scopesFor({ repoRoot, ticketId }) : {};
  const out: string[] = [];

  out.push(BAR);
  out.push(`guardrails  level ${policy.level} — ${policy.name}`);
  out.push(BAR);
  out.push(wrap(policy.note));
  out.push('');

  out.push(`policy source : ${resolved.projectFile ?? `none (default level ${policy.level})`}`);
  out.push(`policy hash   : ${resolved.hash}`);
  out.push(`fail closed   : ${policy.failClosed ? 'yes' : 'no'}`);
  out.push(`unknown action: ${policy.onUnknownAction}`);
  if (ticketId) out.push(`ticket        : ${ticketId}`);
  out.push('');

  const sections: [string, string[]][] = [
    ['sandbox   (WALL)', sandbox.describe(policy)],
    ['secrets   (WALL)', secrets.describe(policy)],
    ['filesystem', layers.filesystem.describe(policy, scopes)],
    ['exec', layers.exec.describe(policy)],
    ['network', layers.network.describe(policy)],
    ['hostexec  (spotlight)', hostexec.describe(policy)],
    ['audit', [policy.audit.enabled ? `on — ${policy.audit.path}` : 'off']],
  ];

  for (const [title, lines] of sections) {
    out.push(`${title}`);
    for (const line of lines) out.push(`  ${line}`);
    out.push('');
  }

  // What still gets through, and why a higher level would help.
  const holes: string[] = [];
  if (!policy.sandbox.enabled) {
    holes.push(
      'No wall. Every layer above is a doorman, so a child process (`node build.js`, ' +
        '`npm run x`) can do things we never see. Level 4 closes this.',
    );
  }
  if (policy.exec.enabled && policy.exec.allowShellStrings) {
    holes.push('Shell strings pass on a coarse scan only. Level 3 refuses them.');
  }
  if (
    policy.network.enabled &&
    policy.network.mode === 'allowlist' &&
    !process.env.GLAFKA_PROXY_URL
  ) {
    holes.push('The host allow list is advisory — nothing enforces it without GLAFKA_PROXY_URL.');
  }
  if (!policy.secrets.enabled) {
    holes.push('The agent inherits your whole environment. This is the cheapest thing to fix.');
  }
  if (policy.level === 0) {
    holes.push(`Nothing is enforced. Set { "level": 2 } in ${PROJECT_POLICY_PATH} to start.`);
  }
  // Not a level setting — a missing event on the other side. The filesystem section above prints its
  // allowRoots either way, so without this line a Cursor user reads a confinement that is not there.
  if (policy.filesystem.enabled && cursorHookInstalled(repoRoot)) {
    holes.push(`Cursor is wired up here, and ${CURSOR_NO_WRITE_HOOK}`);
  }
  // A GRANT, not an escape: `npm install <pkg>` is allowed on purpose, and it runs that package's
  // own postinstall script on this machine, outside the worktree. `npx`/`npm exec`/`pnpm dlx`/`yarn
  // dlx` are on exec.never, which makes it easy to read the whole class as closed. It is not.
  // Said here so nobody assumes it is covered.
  if (policy.exec.enabled && !policy.sandbox.enabled && installsPackages(policy)) {
    holes.push(
      'Installing a package runs its postinstall script on this machine, outside the ' +
        'worktree. That is allowed on purpose so ordinary work keeps running — but with no ' +
        'wall at this level, registry code executes on the host. Level 4 closes it.',
    );
  }

  out.push('still gets through');
  if (holes.length === 0) {
    out.push('  nothing known at this level');
  } else {
    for (const h of holes) out.push(`  · ${wrap(h, 2)}`);
  }
  out.push('');

  if (resolved.widened.length > 0) {
    out.push(`this project LOOSENED (recorded on the ticket): ${resolved.widened.join(', ')}`);
  }
  if (resolved.rejected.length > 0) {
    out.push('refused settings in your project file:');
    for (const r of resolved.rejected) out.push(`  ${r.path} — ${r.why}`);
  }

  return { text: out.join('\n'), resolved };
}

// Every layer shares this much shape. Past that they differ, which is fine,
// because we only look one up by name here.
interface LayerModule {
  meta: LayerMeta;
  // Written as a method, not as a property holding a function.
  // Methods have looser type rules, which is what makes this work.
  describe(policy: Parameters<typeof sandbox.describe>[0], scopes?: unknown): string[];
}

// Every layer `--explain` knows. Exported so the CLI can reject a bad name before calling in, instead
// of printing this function's fallback string and reporting success.
export const LAYER_NAMES: readonly string[] = Object.freeze(
  Object.keys({ ...layers, secrets, sandbox, hostexec }),
);

// Explains one layer, for example `glafka guardrails --explain exec`.
export function explainLayer(
  name: string,
  { repoRoot, ticketId = null }: { repoRoot: string; ticketId?: string | null },
): string {
  const all: Record<string, LayerModule> = { ...layers, secrets, sandbox, hostexec };
  const layer = all[name];
  if (!layer) {
    return `unknown layer "${name}" — known: ${Object.keys(all).join(', ')}`;
  }

  const { policy } = resolvePolicy({ repoRoot });
  const scopes: Scopes | Record<string, never> = ticketId ? scopesFor({ repoRoot, ticketId }) : {};

  // `--explain filesystem` is exactly where someone checks whether a coder is confined, so the harness
  // gap has to be on this page too, not only in the full report's "still gets through".
  const harness =
    name === 'filesystem' && cursorHookInstalled(repoRoot)
      ? ['', `ON CURSOR: ${CURSOR_NO_WRITE_HOOK}`]
      : [];

  return [
    BAR,
    `${layer.meta.name}  (${layer.meta.kind})`,
    BAR,
    `stops      : ${layer.meta.what}`,
    `beaten by  : ${layer.meta.beatenBy}`,
    '',
    'right now:',
    ...layer.describe(policy, scopes).map((l) => `  ${l}`),
    ...harness,
    '',
    `read the code: guardrails/layers/${layer.meta.name}.ts`,
  ].join('\n');
}

// Can this level install a package from a registry? Read off the exec rules rather than hard-coded,
// so a project that removes `npm`/`pnpm`/`yarn` stops being warned about a grant it no longer has.
function installsPackages(policy: ResolvedPolicy['policy']): boolean {
  const INSTALLERS: Record<string, string[]> = {
    npm: ['install', 'i', 'add', 'ci'],
    pnpm: ['install', 'i', 'add'],
    yarn: ['install', 'add'],
    uv: ['add', 'sync', 'pip'],
  };
  return policy.exec.allow.some((rule) => {
    const subs = INSTALLERS[rule.cmd];
    if (!subs) return false;
    if (rule.anyArgs) return true;
    return (rule.subcommands ?? []).some((sub) => subs.includes(sub));
  });
}

function wrap(text: string, indent = 0): string {
  const width = 62 - indent;
  const pad = ' '.repeat(indent);
  const words = String(text).split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if ((line + w).length > width) {
      lines.push(line.trimEnd());
      line = '';
    }
    line += `${w} `;
  }
  if (line.trim()) lines.push(line.trimEnd());
  return lines.join(`\n${pad}`);
}
