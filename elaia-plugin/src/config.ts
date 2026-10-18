import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

// The parts of glafka's settings Elaia reads. Loose: glafka owns this file.
const ConfigSchema = z.object({
  agents: z.record(z.string(), z.string()).optional(),
  baseRef: z.string().optional(),
  checksCmd: z.string().optional(),
});
const IsolationSchema = z.object({
  workspace: z.object({ checksCmd: z.string().optional() }).optional(),
});

function readJson<T>(file: string, schema: z.ZodType<T>): T | null {
  if (!existsSync(file)) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export const readConfig = (project: string) =>
  readJson(path.join(project, '.glafka.json'), ConfigSchema) ?? {};

export const readIsolation = (project: string) =>
  readJson(path.join(project, 'docs', 'glafka', 'architecture', 'isolation.json'), IsolationSchema);

// The shell command for non-Claude chat: your setting first, then glafka's own agents.
export function agentCommandFor(project: string, setting: string): string | null {
  if (setting.trim()) return setting.trim();
  const agents = readConfig(project).agents ?? {};
  return agents.default ?? agents.reporter ?? null;
}

export function baseRefFor(project: string): string {
  return readConfig(project).baseRef ?? 'main';
}
