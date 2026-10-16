import fs from 'node:fs';
import path from 'node:path';

// The agents in .glafka.json. An unreadable file reads as none: writeAgentCmd refuses it anyway.
function configuredAgents(repoRoot: string): Record<string, unknown> {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(repoRoot, '.glafka.json'), 'utf8'));
    return (config?.agents as Record<string, unknown>) ?? {};
  } catch {
    return {};
  }
}

const WHO: Record<string, string> = { verifier: 'the QA tester', coder: 'the coder' };

// Why install must not probe and write agents.<role>, or null when it should. A probe is a
// paid run, and agents.<role> would override the default the project already relies on.
export function roleSetupSkip(repoRoot: string, role: string, env = process.env): string | null {
  const agents = configuredAgents(repoRoot);
  const who = WHO[role] ?? `the ${role}`;
  if (agents[role]) return `left as it is — a ${role} is already configured`;
  if (agents.default) return `agents.${role} not written — ${who} uses agents.default`;
  if (env.GLAFKA_AGENT_CMD) return `agents.${role} not written — ${who} uses GLAFKA_AGENT_CMD`;
  return null;
}
