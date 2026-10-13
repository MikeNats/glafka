import fs from 'node:fs';
import path from 'node:path';
import { redactEnvValues } from './layers/secrets.js';
import type { Policy } from './types/policy.js';
import type { Action, UnreadableExecAction } from './types/action.js';
import type { Decision } from './types/decision.js';
import type { Env } from './types/env.js';

// One JSON line per decision. We only add lines, never change old ones.
// Read this log later to build the allow list for the next level.

function expand(
  template: string,
  { stateDir, ticketId }: { stateDir: string; ticketId: string | null },
): string {
  return template.replace('$stateDir', stateDir).replace('$ticketId', ticketId ?? 'no-ticket');
}

// A size limit for the log. Without one it grows forever, and we read the
// whole file at once. We keep 8MB live, plus one older copy.
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

function rollIfOversized(filePath: string, maxBytes: number): void {
  try {
    if (fs.statSync(filePath).size < maxBytes) return;
    fs.renameSync(filePath, `${filePath}.1`);
  } catch {
    // No file yet, or another process moved it first. Both are fine.
    // A failure here must never stop us saving the decision.
  }
}

// Save how long a value is, never the value.
// A secret could be hiding inside it.
function redactFields(payload: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (fields.includes(key) && typeof value === 'string') {
      out[`${key}Length`] = value.length;
    } else {
      out[key] = value;
    }
  }
  return out;
}

// What we write: one JSON line per call.
// Only this file's own readers use this shape.
export interface AuditLogEntry {
  at: string;
  ticket: string | null;
  op: string;
  allow: boolean;
  layer: string | null;
  reason: string;
  weak?: true;
  needsHuman?: true;
  action: Record<string, unknown>;
}

export function record(
  policy: Policy,
  {
    stateDir,
    ticketId,
    action,
    decision,
    sourceEnv = process.env,
  }: {
    stateDir: string;
    ticketId: string | null;
    action: Action | UnreadableExecAction;
    decision: Decision;
    sourceEnv?: Env;
  },
): string | null {
  const cfg = policy.audit;
  if (!cfg.enabled) return null;

  const filePath = expand(cfg.path, { stateDir, ticketId });
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const entry: AuditLogEntry = {
    at: new Date().toISOString(),
    ticket: ticketId ?? null,
    op: action.op,
    allow: decision.allow,
    layer: decision.layer ?? null,
    reason: decision.reason,
    ...(decision.weak ? { weak: true } : {}),
    ...(decision.needsHuman ? { needsHuman: true } : {}),
    action: redactFields(action as unknown as Record<string, unknown>, cfg.redactFields),
  };

  let line = JSON.stringify(entry);
  line = redactEnvValues(line, sourceEnv, cfg.redactEnvMatching);

  rollIfOversized(filePath, cfg.maxBytes ?? DEFAULT_MAX_BYTES);
  fs.appendFileSync(filePath, `${line}\n`);
  return filePath;
}

// Reads the log back. Broken lines are skipped.
export function read(
  policy: Policy,
  { stateDir, ticketId }: { stateDir: string; ticketId: string | null },
): AuditLogEntry[] {
  const filePath = expand(policy.audit.path, { stateDir, ticketId });
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line): AuditLogEntry[] => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

// Sums up the log: what the agent tried.
// Use it to build the next level's allow list.
export function summarise(entries: AuditLogEntry[]): {
  total: number;
  commands: [string, number][];
  deniedCount: number;
  denied: AuditLogEntry[];
  outsidePaths: string[];
} {
  const commands = new Map<string, number>();
  const denied: AuditLogEntry[] = [];
  const outsidePaths = new Set<string>();

  for (const e of entries) {
    if (e.op === 'exec') {
      const argv = e.action.argv as string[] | undefined;
      const commandString = e.action.commandString as string | undefined;
      const name = argv?.[0]?.split('/').pop() ?? commandString?.split(/\s+/)[0];
      if (name) commands.set(name, (commands.get(name) ?? 0) + 1);
    }
    if (!e.allow) denied.push(e);
    if (e.op !== 'exec' && !e.allow && e.action.filePath)
      outsidePaths.add(e.action.filePath as string);
  }

  return {
    total: entries.length,
    commands: [...commands.entries()].sort((a, b) => b[1] - a[1]),
    deniedCount: denied.length,
    denied: denied.slice(-20),
    outsidePaths: [...outsidePaths],
  };
}
