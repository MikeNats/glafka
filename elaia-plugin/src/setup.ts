import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { baseRefFor, readConfig, readIsolation } from './config';
import { glafkaDir } from './files';

// One line of the setup card. Checked from files only: no agent, no cost.
export interface SetupItem {
  key: SetupKey;
  label: string;
  done: boolean;
  // Nice to have; the card does not insist on it.
  optional: boolean;
}

export const SETUP_KEYS = [
  'installed',
  'map',
  'checks',
  'agents',
  'coder',
  'base',
  'guardrails',
] as const;
export type SetupKey = (typeof SETUP_KEYS)[number];

function branchExists(project: string, branch: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', branch], {
      cwd: project,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

// A QA agent glafka can start for the acceptance criteria (the same lookup glafka makes).
export function hasVerifier(project: string): boolean {
  const agents = readConfig(project).agents;
  return Boolean(agents?.verifier ?? agents?.default ?? process.env.GLAFKA_AGENT_CMD);
}

// A coder that runs with nobody watching: what `plan --background` needs to start one.
export function hasCoder(project: string): boolean {
  const agents = readConfig(project).agents;
  return Boolean(agents?.coder ?? agents?.default ?? process.env.GLAFKA_AGENT_CMD);
}

export function setupStatus(project: string): SetupItem[] {
  const docs = path.join(project, 'docs', 'glafka');
  const config = readConfig(project);
  const base = baseRefFor(project);
  const item = (key: SetupKey, label: string, done: boolean, optional = false) => ({
    key,
    label,
    done,
    optional,
  });
  return [
    item('installed', 'glafka installed', existsSync(glafkaDir(project)) && existsSync(docs)),
    // README.md from the AI map; scan.json alone from the code graph.
    item(
      'map',
      'Code map',
      ['README.md', 'scan.json'].some((f) => existsSync(path.join(docs, 'architecture', f))),
    ),
    item(
      'checks',
      'Check command',
      Boolean(config.checksCmd ?? readIsolation(project)?.workspace?.checksCmd),
    ),
    item('agents', 'Review agents', Boolean(config.agents?.reviewer ?? config.agents?.default)),
    item('coder', 'Coder agent (runs tickets on its own)', hasCoder(project)),
    item('base', `Base branch \`${base}\``, branchExists(project, base)),
    item('guardrails', 'Guardrails', existsSync(path.join(docs, 'guardrails.json')), true),
  ];
}

const STEPS: Record<Exclude<SetupKey, 'installed'>, string> = {
  map: 'Mapping the code failed (the output is in the details above). Tell me in plain words why, and what I can do.',
  checks:
    'glafka found no check command. Ask me what this project runs for lint, typecheck and tests. Then set `checksCmd` in .glafka.json.',
  agents:
    'Review agents are not set. Explain in plain words what `agents` in .glafka.json does, and propose a value.',
  coder:
    'No coder agent is set: glafka install could not test one. If .glafka.json has `agents.reporter`, copy it to ' +
    '`agents.coder` without asking (pressing Set up was my OK). If not, tell me in one line why install failed.',
  base: 'The base branch does not exist here. Ask me which branch tickets should start from, then set `baseRef` in .glafka.json.',
  guardrails:
    'Guardrails are off. Explain the levels in plain words and recommend one. Level 2 and up allow only some glafka ' +
    'commands, and writes only inside a ticket worktree: say what that would block in Elaia. Do not change it without my OK.',
};

// What the main chat is asked to do for the steps still open.
export function setupPrompt(missing: SetupKey[]): string {
  const steps = missing.flatMap((key) => (key === 'installed' ? [] : [STEPS[key]]));
  return [
    'Set up glafka in this repo. Go step by step. Ask me before you change a file, unless a step says not to.',
    '',
    ...steps.map((step, i) => `${i + 1}. ${step}`),
    '',
    'At the end, list in plain words what is set up and what is still open.',
  ].join('\n');
}
