import fs from 'node:fs';
import path from 'node:path';
import { AGENT_INSTRUCTION_FILES } from '../commands/install/install.js';

// The project's own instruction files — CLAUDE.md, AGENTS.md and friends. These are NOT a prompt
// context section: glafka never reads their contents, it only tells an agent which of them exist so
// the agent can open them itself. That is why they live apart from context.ts, which is about text
// glafka reads and injects.

// The ones this project actually has, of the ones our platforms read. Listing all of them told an
// agent to open files that were not there; four existsSync calls cost about 3us, so asking is
// cheaper than guessing.
export function presentInstructionFiles(repoRoot: string): string[] {
  return AGENT_INSTRUCTION_FILES.filter((file) => fs.existsSync(path.join(repoRoot, file)));
}

// "CLAUDE.md", or "CLAUDE.md and AGENTS.md". Empty when the project has none,
// and every caller drops its whole section in that case.
export function agentInstructionFileList(repoRoot: string): string {
  const found = presentInstructionFiles(repoRoot);
  if (found.length === 0) return '';
  return found.length === 1
    ? found[0]!
    : `${found.slice(0, -1).join(', ')} and ${found[found.length - 1]}`;
}
