import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
// glafka's own git lookup. Only node's own modules come with it, so it is safe to bundle.
import { detectBaseRef } from '../../src/util/git.js';

// The parts of glafka's settings Elaia reads. glafka owns these files and allows null for
// baseRef, checksCmd and agents, so each field is read on its own: one cannot drop the rest.
export interface GlafkaConfig {
  agents?: Record<string, string>;
  baseRef?: string;
  checksCmd?: string;
}

function readJson(file: string): unknown {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// One field of a JSON object, or undefined when it is missing, null or not this shape.
function fieldOf<T>(json: unknown, key: string, schema: z.ZodType<T>): T | undefined {
  if (typeof json !== 'object' || json === null) return undefined;
  const parsed = schema.safeParse((json as Record<string, unknown>)[key]);
  return parsed.success ? parsed.data : undefined;
}

export function readConfig(project: string): GlafkaConfig {
  const json = readJson(path.join(project, '.glafka.json'));
  return {
    agents: fieldOf(json, 'agents', z.record(z.string(), z.string())),
    baseRef: fieldOf(json, 'baseRef', z.string()),
    checksCmd: fieldOf(json, 'checksCmd', z.string()),
  };
}

export function readIsolation(project: string) {
  const file = path.join(project, 'docs', 'glafka', 'architecture', 'isolation.json');
  const workspace = fieldOf(readJson(file), 'workspace', z.record(z.string(), z.unknown()));
  return {
    workspace: {
      baseRef: fieldOf(workspace, 'baseRef', z.string()),
      checksCmd: fieldOf(workspace, 'checksCmd', z.string()),
    },
  };
}

// The shell command for non-Claude chat: your setting first, then glafka's own agents.
export function agentCommandFor(project: string, setting: string): string | null {
  if (setting.trim()) return setting.trim();
  const agents = readConfig(project).agents ?? {};
  return agents.default ?? agents.reporter ?? null;
}

// glafka's own order (resolveBaseRef): your setting, the approved scan, then what git says
// (origin/HEAD, main, master, trunk, the current branch), then main.
export function baseRefFor(project: string): string {
  return (
    readConfig(project).baseRef ||
    readIsolation(project).workspace.baseRef ||
    detectBaseRef(project) ||
    'main'
  );
}
