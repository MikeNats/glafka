import fs from 'node:fs';
import { ROLES } from './types/ticket.js';
import path from 'node:path';
import { detectBaseRef, refExists } from './util/git.js';
import { DEFAULT_ISOLATION_HOOK_TIMEOUT_MS } from './ticket/resources.js';
import { ConfigSchema, type Config } from './types/config.js';
import type { IsolationProfile } from './types/isolationProfile.js';

const CONFIG_FILENAME = '.glafka.json';

const DEFAULTS: Config = {
  baseRef: null,
  checksCmd: null,
  e2eCmd: null,
  portRange: { start: 4100, end: 4199 },
  ergonTimeoutMs: 60 * 60 * 1000,
  checksTimeoutMs: 10 * 60 * 1000,
  e2eTimeoutMs: 10 * 60 * 1000,
  bootstrapTimeoutMs: 15 * 60 * 1000,
  isolationHookTimeoutMs: DEFAULT_ISOLATION_HOOK_TIMEOUT_MS,
  agents: {},
  maxReviewRounds: 3,
  notifyCmd: null,
  reviewDoc: null,
  observability: { enabled: true },
};

// A missing file or field falls back to a default.
// A wrong or unknown field throws an error that names it.
export function loadConfig(repoRoot: string): Config {
  const filePath = path.join(repoRoot, CONFIG_FILENAME);
  if (!fs.existsSync(filePath)) return { ...DEFAULTS };

  // JSON.parse's own message names a character offset and nothing else. glafka reads at least four JSON
  // files from a project, so a parse error that names none of them is a hunt. Every other config file here already names itself.
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new Error(`${filePath}: not valid JSON — ${(err as Error).message}`);
  }
  const merged = {
    ...DEFAULTS,
    ...raw,
    portRange: { ...DEFAULTS.portRange, ...(raw.portRange ?? {}) },
    observability: { ...DEFAULTS.observability, ...(raw.observability ?? {}) },
    // Not merged in. A wrong value must fail the check below
    // with a clear error, not be quietly patched up.
    agents: raw.agents ?? DEFAULTS.agents,
  };

  const result = ConfigSchema.safeParse(merged);
  if (!result.success) {
    const description = result.error.issues
      .map((issue) =>
        issue.path.length > 0 ? `"${issue.path.join('.')}" ${issue.message}` : issue.message,
      )
      .join('; ');
    throw new Error(`${CONFIG_FILENAME}: ${description}`);
  }
  return result.data;
}

// Which branch a ticket starts from. We try, in order: your config file,
// the scan's file, what git reports, and finally "main".
export function resolveBaseRef({
  repoRoot,
  config = {},
  profile = null,
}: {
  repoRoot: string;
  config?: Partial<Pick<Config, 'baseRef'>>;
  profile?: Pick<IsolationProfile, 'workspace'> | null;
}): string {
  if (config.baseRef) return config.baseRef;

  const fromProfile = profile?.workspace?.baseRef;
  if (fromProfile) return fromProfile;

  const detected = detectBaseRef(repoRoot);
  if (detected) return detected;

  return 'main';
}

// How this project runs its own checks, in the same order as above.
// We never guess the command. Finding it is a one-time job for the agent.
export function resolveChecksCmd({
  config = {},
  profile = null,
}: {
  config?: Partial<Pick<Config, 'checksCmd'>>;
  profile?: Pick<IsolationProfile, 'workspace'> | null;
}): string | null {
  return config.checksCmd ?? profile?.workspace?.checksCmd ?? null;
}

export function resolveE2eCmd({
  config = {},
  profile = null,
}: {
  config?: Partial<Pick<Config, 'e2eCmd'>>;
  profile?: Pick<IsolationProfile, 'workspace'> | null;
}): string | null {
  return config.e2eCmd ?? profile?.workspace?.e2eCmd ?? null;
}

// Which shell command starts an agent for a role. It is a plain command,
// so any tool works. The most exact setting wins, then a default, then null.
export function resolveAgentCmd({
  config = {},
  role,
}: {
  config?: Partial<Pick<Config, 'agents'>>;
  role: string;
}): string | null {
  return config.agents?.[role] ?? config.agents?.default ?? process.env.GLAFKA_AGENT_CMD ?? null;
}

// A command that can actually do the job, per agent. `claude -p` alone was recommended here and in
// the README for a long time, and it cannot write a file: in print mode every tool call that would
// need approval is denied, so the coder reads the plan, asks for permission nobody is there to
// grant, and exits 0 — which glafka then reports as a finished run. Whatever
// example we print has to be one that works.
export const EXAMPLE_AGENT_CMD = 'claude -p --permission-mode acceptEdits';

// One message for every "no agent configured" refusal. It names all three sources resolveAgentCmd
// reads, in the order it reads them — naming only the env var sends someone who already set
// `agents.coder` looking in the wrong place, and `.glafka.json` is the setting that actually wins.
export function noAgentCmd(what: string, role = ROLES.CODER): string {
  return (
    `${what} needs a command to run the ${role} agent, and none is configured. Set one of:\n` +
    `  "agents": { "${role}": "${EXAMPLE_AGENT_CMD}" }   in ${CONFIG_FILENAME}   (most specific, wins)\n` +
    `  "agents": { "default": "${EXAMPLE_AGENT_CMD}" }  in ${CONFIG_FILENAME}\n` +
    `  GLAFKA_AGENT_CMD="${EXAMPLE_AGENT_CMD}"          in the environment\n` +
    `\n` +
    `  Any agent glafka supports works here: Claude Code, Cursor, OpenCode, Gemini,\n` +
    `  Kimi, GitHub Copilot. What matters is that it edits files and runs commands\n` +
    `  WITHOUT asking, because nobody is watching it. An agent left in its asking\n` +
    `  mode is refused, then exits reporting success — a bare \`claude -p\` does\n` +
    `  exactly that. Use your agent's own non-interactive flags (Claude Code:\n` +
    `  \`--permission-mode acceptEdits\` plus an \`--allowedTools\` list covering your\n` +
    `  test and git commands). glafka's guardrails are what limit it after that —\n` +
    `  see \`glafka guardrails\`.`
  );
}

// Kept apart so a caller can warn instead of crash. The raw git error
// names neither the setting nor the file it came from.
export function assertBaseRefExists(
  repoRoot: string,
  baseRef: string,
  { source = 'resolved' }: { source?: string } = {},
): void {
  if (refExists(repoRoot, baseRef)) return;
  throw new Error(
    `baseRef "${baseRef}" (${source}) does not exist in this repo. ` +
      `Set "baseRef" in .glafka.json to the branch tickets should be cut from.`,
  );
}
