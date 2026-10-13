import fs from 'node:fs';
import path from 'node:path';

// A local, loose shape for the isolation profile file.
// It moves to src/types/isolationProfile.ts once docsStore.js is converted.
interface ServiceDef {
  name: string;
  envVars: string[];
}
interface IsolationProfileLike {
  services?: ServiceDef[];
  workspace?: {
    submodules?: { paths?: string[]; branchPerTicket?: boolean };
    seedFiles?: string[];
    bootstrapCmd?: string;
  };
  setupCmd?: string;
  seedCmd?: string;
  wakeCmd?: string;
  teardownCmd?: string;
  devCmd?: string;
  healthCmd?: string;
  e2e?: {
    services?: ServiceDef[];
    setupCmd?: string;
    teardownCmd?: string;
  };
}

export function servicesOf(profile: IsolationProfileLike | null | undefined): ServiceDef[] {
  return [...(profile?.services ?? []), ...(profile?.e2e?.services ?? [])];
}

export function envFor(service: ServiceDef, port: number): Record<string, string> {
  const env: Record<string, string> = {};
  for (const envVar of service.envVars) env[envVar] = String(port);
  return env;
}

// The env vars a ticket's reserved ports stand for. A port whose service the
// profile no longer lists is skipped, because there is nothing to set it on.
export function portEnv(
  profile: IsolationProfileLike | null | undefined,
  isolationPorts: Record<string, number> | null | undefined,
): Record<string, string> {
  const services = servicesOf(profile);
  let env: Record<string, string> = {};
  for (const [name, port] of Object.entries(isolationPorts ?? {})) {
    const service = services.find((s) => s.name === name);
    if (service) env = { ...env, ...envFor(service, port) };
  }
  return env;
}

// Plain KEY=VALUE lines and nothing else. No quotes are stripped, no $VAR is
// expanded, and a value stops at the end of its line.
export function parseEnvLines(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match) env[match[1]] = match[2];
  }
  return env;
}

// Where a ticket's own environment lives in its worktree: the reserved ports,
// plus every KEY=VALUE line setupCmd printed.
export const TICKET_ENV_FILE = '.env.glafka';

// The project's .gitignore knows nothing about glafka,
// so we add the ignore line ourselves.
export function ensureEnvIgnored(worktree: string): boolean {
  const gitignore = path.join(worktree, '.gitignore');
  const existing = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, 'utf8') : '';
  if (existing.split('\n').some((line) => line.trim() === TICKET_ENV_FILE)) return false;
  fs.writeFileSync(gitignore, `${existing.trimEnd()}\n${TICKET_ENV_FILE}\n`.trimStart());
  return true;
}

// What provisioning left in the worktree: the ports, and everything setupCmd
// printed. A project may have no such file, and that must not stop a start.
export function readTicketEnv(worktree: string): Record<string, string> {
  try {
    return parseEnvLines(fs.readFileSync(path.join(worktree, TICKET_ENV_FILE), 'utf8'));
  } catch {
    return {};
  }
}

export type { ServiceDef, IsolationProfileLike };
