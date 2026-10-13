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

// Why install must not probe and write agents.verifier, or null when it should. A probe is a
// paid run, and agents.verifier would override the default the project already relies on.
export function verifierSetupSkip(repoRoot: string, env = process.env): string | null {
  const agents = configuredAgents(repoRoot);
  if (agents.verifier) return 'left as it is — a verifier is already configured';
  if (agents.default) return 'agents.verifier not written — the QA tester uses agents.default';
  if (env.GLAFKA_AGENT_CMD) {
    return 'agents.verifier not written — the QA tester uses GLAFKA_AGENT_CMD';
  }
  return null;
}
