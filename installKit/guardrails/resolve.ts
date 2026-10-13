import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  PolicyOverrideSchema,
  type ExecRule,
  type Policy,
  type PolicyOverride,
} from './types/policy.js';
import type { Scopes } from './types/scopes.js';

// Turns "level 2 plus project changes" into one locked policy object.
// A change can tighten, loosen, or be refused. Nothing is dropped in silence.

const GUARDRAILS_DIR = path.dirname(fileURLToPath(import.meta.url));
const LEVELS_DIR = path.join(GUARDRAILS_DIR, 'levels');

export const PROJECT_POLICY_PATH = path.join('docs', 'glafka', 'guardrails.json');
export const DEFAULT_LEVEL = 0;

function levelFile(level: number): string {
  const found = fs
    .readdirSync(LEVELS_DIR)
    .find((name) => name.startsWith(`${level}-`) && name.endsWith('.json'));
  if (!found) {
    const known = fs
      .readdirSync(LEVELS_DIR)
      .map((n) => n[0])
      .join(', ');
    throw new Error(`guardrails: unknown level ${level} (known levels: ${known})`);
  }
  return path.join(LEVELS_DIR, found);
}

// The level files ship with glafka, so we trust them.
// This only reads the JSON, it does not check its shape.
export function loadLevel(level: number): Policy {
  return JSON.parse(fs.readFileSync(levelFile(level), 'utf8')) as Policy;
}

// Reads the project's file from the MAIN checkout, never a worktree.
export function readProjectPolicy(repoRoot: string): {
  raw: PolicyOverride | null;
  filePath: string;
} {
  const filePath = path.join(repoRoot, PROJECT_POLICY_PATH);
  if (!fs.existsSync(filePath)) return { raw: null, filePath };

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    // Stop instead of continuing. A broken file must not mean "no rules".
    throw new Error(
      `guardrails: ${PROJECT_POLICY_PATH} is not valid JSON (${(err as Error).message}) — refusing to run with no policy`,
    );
  }

  const result = PolicyOverrideSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `guardrails: ${PROJECT_POLICY_PATH} does not match the expected shape (${result.error.message}) — refusing to run with no policy`,
    );
  }
  return { raw: result.data, filePath };
}

// --------------------------------------------------------------------------- Applying the override

function get(obj: Record<string, unknown>, dotted: string): unknown {
  return dotted
    .split('.')
    .reduce<unknown>((acc, k) => (acc == null ? acc : (acc as Record<string, unknown>)[k]), obj);
}

function set(obj: Record<string, unknown>, dotted: string, value: unknown): void {
  const keys = dotted.split('.');
  const last = keys.pop() as string;
  const target = keys.reduce<Record<string, unknown>>((acc, k) => {
    const existing = acc[k] as Record<string, unknown> | undefined;
    if (existing != null) return existing;
    const created: Record<string, unknown> = {};
    acc[k] = created;
    return created;
  }, obj);
  target[last] = value;
}

// Every setting in the override, written as a dotted name.
function leafPaths(obj: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const dotted = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      out.push(...leafPaths(value as Record<string, unknown>, dotted));
    } else {
      out.push(dotted);
    }
  }
  return out;
}

// Adding to some lists loosens the rules, adding to others tightens them.
// The tightening ones are named here.
const DENY_STYLE = new Set([
  'filesystem.denyWithin',
  'exec.never',
  'audit.redactEnvMatching',
  'hostexec.hostExecutingPatterns',
]);

// Entries in the allow list are objects named by `cmd`.
function ruleCmd(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null;
  const cmd = (value as { cmd?: unknown }).cmd;
  return typeof cmd === 'string' ? cmd : null;
}

// Does this rule allow MORE than the base rule for the same command?
function ruleWidens(baseRule: ExecRule | undefined, newRule: ExecRule): boolean {
  // A command the level did not allow at all is always more.
  if (!baseRule) return true;
  if (newRule.anyArgs && !baseRule.anyArgs) return true;
  if (!baseRule.anyArgs) {
    const baseSubs = new Set(baseRule.subcommands ?? []);
    if ((newRule.subcommands ?? []).some((s) => !baseSubs.has(s))) return true;
  }
  // Dropping a banned flag also allows more.
  const newDeny = new Set(newRule.denyArgs ?? []);
  if ((baseRule.denyArgs ?? []).some((d) => !newDeny.has(d))) return true;
  return false;
}

// Does this change loosen the level? We compare what the rules MEAN, not
// their exact text, or cutting a list down would look like adding to it.
function isWiden(dotted: string, baseValue: unknown, newValue: unknown): boolean {
  if (DENY_STYLE.has(dotted)) return false;
  if (!Array.isArray(baseValue) || !Array.isArray(newValue)) {
    return baseValue !== newValue;
  }
  if (newValue.every((v) => ruleCmd(v) !== null)) {
    const byCmd = new Map<string, ExecRule>();
    for (const rule of baseValue) {
      const cmd = ruleCmd(rule);
      if (cmd !== null && !byCmd.has(cmd)) byCmd.set(cmd, rule as ExecRule);
    }
    return (newValue as ExecRule[]).some((rule) => ruleWidens(byCmd.get(rule.cmd), rule));
  }
  const baseKeys = new Set(baseValue.map((v) => JSON.stringify(v)));
  return newValue.some((v) => !baseKeys.has(JSON.stringify(v)));
}

// Tightening lists join together, since keeping both is the safe choice.
// Loosening lists REPLACE, or you could never cut anything down.
function mergeValue(dotted: string, baseValue: unknown, newValue: unknown): unknown {
  if (Array.isArray(baseValue) && Array.isArray(newValue) && DENY_STYLE.has(dotted)) {
    const seen = new Set(baseValue.map((v) => JSON.stringify(v)));
    return [...baseValue, ...newValue.filter((v) => !seen.has(JSON.stringify(v)))];
  }
  return newValue;
}

export interface RejectedOverride {
  path: string;
  why: string;
}

export interface AppliedOverride {
  policy: Policy;
  widened: string[];
  rejected: RejectedOverride[];
}

export function applyOverride(base: Policy, override: PolicyOverride): AppliedOverride {
  const policy = structuredClone(base) as unknown as Record<string, unknown>;
  const rules = base.override;
  const widened: string[] = [];
  const rejected: RejectedOverride[] = [];

  for (const dotted of leafPaths(override as Record<string, unknown>)) {
    // "level" and "note" describe the base. They are not changes.
    if (dotted === 'level' || dotted === 'note') continue;

    if (
      rules.neverOverridable.some((locked) => dotted === locked || dotted.startsWith(`${locked}.`))
    ) {
      rejected.push({ path: dotted, why: 'locked at this level' });
      continue;
    }

    const baseValue = get(base as unknown as Record<string, unknown>, dotted);
    const newValue = get(override as Record<string, unknown>, dotted);
    const widens = isWiden(dotted, baseValue, newValue);
    const allowedList = widens ? rules.mayWiden : rules.mayNarrow;

    if (!allowedList.includes(dotted)) {
      rejected.push({
        path: dotted,
        why: widens
          ? `widening "${dotted}" is not permitted at level ${base.level}`
          : `"${dotted}" is not an adjustable setting at level ${base.level}`,
      });
      continue;
    }

    const merged = mergeValue(dotted, baseValue, newValue);

    // A change that changes nothing must say so. Accepting it quietly made us
    // report a loosening that never happened.
    if (JSON.stringify(merged) === JSON.stringify(baseValue)) {
      rejected.push({ path: dotted, why: 'no effect — it already matches the level default' });
      continue;
    }

    set(policy, dotted, merged);
    if (widens) widened.push(dotted);
  }

  return { policy: policy as unknown as Policy, widened, rejected };
}

// --------------------------------------------------------------------------- The public entry

export interface ResolvedPolicy {
  policy: Readonly<Policy>;
  level: number;
  levelName: string;
  projectFile: string | null;
  widened: string[];
  rejected: RejectedOverride[];
  hash: string;
}

// Returns the final policy, its level, what changed,
// and a fingerprint we save on the ticket.
export function resolvePolicy({
  repoRoot,
  levelOverride = null,
}: {
  repoRoot: string;
  levelOverride?: number | null;
}): ResolvedPolicy {
  const { raw, filePath } = readProjectPolicy(repoRoot);
  const level = levelOverride ?? raw?.level ?? DEFAULT_LEVEL;
  const base = loadLevel(level);

  const { policy, widened, rejected } = raw
    ? applyOverride(base, raw)
    : {
        policy: structuredClone(base),
        widened: [] as string[],
        rejected: [] as RejectedOverride[],
      };

  const hash = crypto
    .createHash('sha256')
    .update(JSON.stringify(policy))
    .digest('hex')
    .slice(0, 16);

  return {
    policy: Object.freeze(policy),
    level,
    levelName: base.name,
    projectFile: raw ? filePath : null,
    widened,
    rejected,
    hash,
  };
}

// The full paths behind the names the layers use.
// We read the scratch path from its own env var, never from TMPDIR.
export function scopesFor({ repoRoot, ticketId }: { repoRoot: string; ticketId: string }): Scopes {
  return {
    TICKET_WORKTREE: path.join(repoRoot, '.worktrees', ticketId),
    TICKET_SCRATCH: process.env.GLAFKA_TICKET_SCRATCH ?? path.join(os_tmp(), `glafka-${ticketId}`),
  };
}

function os_tmp(): string {
  return process.env.TMPDIR?.replace(/\/$/, '') ?? '/tmp';
}
