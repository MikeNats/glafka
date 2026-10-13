import type { Policy } from '../types/policy.js';
import type { Env } from '../types/env.js';
import type { LayerMeta } from '../types/layer.js';

// LAYER: secrets — the agent never holds a secret in the first place.
// We block secrets coming IN, instead of blocking every way OUT.

export const meta: LayerMeta = {
  name: 'secrets',
  kind: 'wall',
  rung: 3,
  what: "the agent's environment keeps only harmless variables",
  beatenBy: 'nothing — you cannot read a variable that was never passed',
};

// The agent must hold one secret: its own model API key.
// Use a key made just for the agent, with limited rights.

// Names that look like a secret. Used for the log and the warning below.
const SECRET_SHAPED =
  /SECRET|TOKEN|PASS|PWD|KEY|CREDENTIAL|AUTH|DATABASE_URL|DSN|CONNECTION_STRING|PRIVATE|SALT|SESSION|COOKIE|WEBHOOK/i;

// Normal variables whose names look secret but whose values never are. These match on the WHOLE name, not on a piece of it.
export const NEVER_REDACTED: ReadonlySet<string> = new Set([
  'PWD',
  'OLDPWD',
  'HOME',
  'PATH',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SHELL',
  'TERM',
  'LANG',
  'LC_ALL',
  'USER',
  'LOGNAME',
  'SSH_AUTH_SOCK',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'GLAFKA_PROMPT_FILE',
  'GLAFKA_LOG_FILE',
  'GLAFKA_EXIT_FILE',
  'GLAFKA_TICKET_SCRATCH',
]);

// May we hide this variable's VALUE in the output? A matching name is not
// enough on its own, or we would blank out ordinary paths.
export function looksSecret(name: string, patterns: string[]): boolean {
  if (NEVER_REDACTED.has(name)) return false;
  return patterns.some((p) => new RegExp(p, 'i').test(name));
}

// Must this value stay off a command line, like `docker run --env`? We go by
// the SHAPE of the name: naming each vendor misses the next one that ships.
export function isSecretName(name: string): boolean {
  return looksSecret(name, [SECRET_SHAPED.source]);
}

// A long list of dropped names helps nobody, so the warning shows a few.
const MAX_NAMED_DROPS = 5;
const PROJECT_POLICY_HINT = 'docs/glafka/guardrails.json';

// Credentials that belong to ONE agent, and that buy more than inference. The model API keys on
// `keepEnv` (Anthropic, OpenAI, Gemini, Moonshot, Cursor) buy tokens. `GITHUB_TOKEN` buys `git
// push`, `gh pr create` and `gh pr merge` — the exact actions `exec.never` and
// `approval.needsHumanYes` exist to withhold. It is on the list only because it is how GitHub
// Copilot signs in, so any agent that is NOT Copilot gets a credential it cannot use and should not
// hold. Matched on the resolved agent command, which is the only thing
// that knows which agent is really about to run.
const AGENT_OWNED_CREDENTIALS: { name: string; ownerPattern: RegExp; owner: string }[] = [
  { name: 'GITHUB_TOKEN', ownerPattern: /(^|[/\\\s])(copilot|gh\s+copilot)\b/i, owner: 'Copilot' },
];

// Which agent-owned credentials this command must NOT be handed. A command we were not given is
// left alone on purpose: dropping on "unknown" would break Copilot sign-in for anyone whose agent
// glafka cannot see, which is the regression an existing test already caught once. Unknown warns
// instead, so the remaining surface is stated rather than silent.
function credentialsNotOwnedBy(agentCmd: string | null): typeof AGENT_OWNED_CREDENTIALS {
  if (agentCmd == null || agentCmd.trim() === '') return [];
  return AGENT_OWNED_CREDENTIALS.filter((c) => !c.ownerPattern.test(agentCmd));
}

// Builds the env vars the agent gets. It is an allow list, so a new secret
// added later is dropped by default. `extra` is our own safe values.
export function buildEnv(
  policy: Policy,
  sourceEnv: Env,
  extra: Env = {},
  // The command that is actually about to run. Optional, because two callers
  // (`logos`, `odysse`) build an env for glafka's own use, not for an agent.
  { agentCmd = null }: { agentCmd?: string | null } = {},
): { env: Env; dropped: string[]; warnings: string[] } {
  const cfg = policy.secrets;

  if (!cfg.enabled) {
    return { env: { ...sourceEnv, ...extra }, dropped: [], warnings: [] };
  }

  const env: Env = {};
  const dropped: string[] = [];
  const foreign = credentialsNotOwnedBy(agentCmd);
  const foreignNames = new Set(foreign.map((c) => c.name));

  for (const [name, value] of Object.entries(sourceEnv)) {
    // On keepEnv, but it belongs to a different agent than the one running. Dropped here rather than
    // removed from the level files, because the level cannot know which agent a project configured.
    if (cfg.keepEnv.includes(name) && !foreignNames.has(name)) {
      env[name] = value;
    } else {
      dropped.push(name);
    }
  }

  // Warn, do not block. Sometimes a throwaway value here is fine. A credential we just dropped as
  // foreign is not warned about — it is not being handed over, so there is nothing to make throwaway.
  const warnings = cfg.keepEnv
    .filter((name) => SECRET_SHAPED.test(name) && !foreignNames.has(name))
    .map(
      (name) =>
        `keepEnv includes "${name}", which looks like a secret — make sure it is a throwaway value`,
    );

  for (const credential of foreign) {
    if (sourceEnv[credential.name] === undefined) continue;
    warnings.push(
      `"${credential.name}" was NOT passed to the agent: it is ${credential.owner}'s sign-in ` +
        `credential, and the agent about to run is not ${credential.owner}. It can push, open ` +
        `and merge pull requests, which exec.never withholds — so a different agent has no use ` +
        `for it. If yours does need it, name it in secrets.keepEnv in ${PROJECT_POLICY_HINT}.`,
    );
  }

  // We could not tell which agent this is, so nothing was gated. Say so
  // rather than let the stronger guarantee be assumed.
  if (agentCmd == null || agentCmd.trim() === '') {
    const ungated = AGENT_OWNED_CREDENTIALS.filter(
      (c) => cfg.keepEnv.includes(c.name) && sourceEnv[c.name] !== undefined,
    );
    for (const credential of ungated) {
      warnings.push(
        `"${credential.name}" was passed WITHOUT checking which agent is running (no agent ` +
          `command resolved). It is only meant for ${credential.owner}; any other agent now ` +
          `holds a credential that can push and merge.`,
      );
    }
  }

  // A dropped credential is not a safety win if the agent needed it: the run
  // just fails to sign in, with an error that never names the real cause.
  const droppedCredentials = dropped.filter((name) => isSecretName(name));
  if (droppedCredentials.length > 0) {
    warnings.push(
      `${droppedCredentials.length} credential-shaped variable(s) were dropped and the agent ` +
        `will not see them: ${droppedCredentials.slice(0, MAX_NAMED_DROPS).join(', ')}` +
        `${droppedCredentials.length > MAX_NAMED_DROPS ? ', …' : ''} — ` +
        `if the agent needs one to sign in, add it to secrets.keepEnv in ${PROJECT_POLICY_HINT}`,
    );
  }

  return { env: { ...env, ...extra }, dropped, warnings };
}

export function describe(policy: Policy): string[] {
  const cfg = policy.secrets;
  if (!cfg.enabled) {
    return ['off — the agent inherits your whole environment, secrets included'];
  }
  const lines = [
    `agent keeps ${cfg.keepEnv.length} variable(s): ${cfg.keepEnv.join(', ')}`,
    '  everything else is dropped, including anything you add to your shell later',
  ];
  // The list above is not the whole answer for these, and reading it as one
  // is how a token ends up somewhere it was never meant to go.
  for (const credential of AGENT_OWNED_CREDENTIALS) {
    if (!cfg.keepEnv.includes(credential.name)) continue;
    lines.push(
      `  "${credential.name}" is conditional: kept only when the agent about to run is ` +
        `${credential.owner}, whose sign-in it is. Any other agent gets it dropped — it can ` +
        `push and merge, which exec.never withholds. With no agent command resolved, it is ` +
        `passed and a warning says so.`,
    );
  }
  return lines;
}

// Used by the log, so a real secret never reaches the disk.
export function redactEnvValues(text: string, sourceEnv: Env, patterns: string[]): string {
  const values: string[] = [];
  for (const [name, value] of Object.entries(sourceEnv)) {
    if (!value || value.length < 4) continue;
    if (!looksSecret(name, patterns)) continue;
    values.push(value);
  }
  if (values.length === 0) return text;

  // Longest first, so a short secret inside a longer one
  // does not leave part of it showing.
  const pattern = values
    .sort((a, b) => b.length - a.length)
    .map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');

  return text.replace(new RegExp(pattern, 'g'), '[REDACTED]');
}
