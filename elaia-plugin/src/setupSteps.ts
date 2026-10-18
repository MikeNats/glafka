import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runGlafka, type RunResult } from './run';

// A setup step glafka does itself; `key` is the setup item it fixes.
interface SetupRun {
  key: string;
  label: string;
  done: string;
  run(): Promise<RunResult>;
}
interface SetupFinding {
  key: string;
  title: string;
  items: string[];
  keep: string;
}

// The code map waits for the code map tool's first download; the AI map takes longer still.
const MAP_TIMEOUT = 3_600_000;
const CHECKS_TIMEOUT = 900_000;
const LIST_TIMEOUT = 60_000;

const proposalFile = (project: string) =>
  path.join(project, 'docs', 'glafka', 'architecture', 'workspace.proposed.json');

function proposedChecks(project: string): boolean {
  try {
    return Boolean(JSON.parse(readFileSync(proposalFile(project), 'utf8')).checksCmd);
  } catch {
    return false;
  }
}

// What glafka does itself, with no agent: find the check command, then map the code.
export function autoSetup(bin: string, project: string, missing: string[]): SetupRun[] {
  const runs: SetupRun[] = [];
  if (missing.includes('checks') && !proposedChecks(project)) {
    runs.push({
      key: 'checks',
      label: 'Finding the check command',
      done: 'Check command search done.',
      run: () => runGlafka(bin, ['odysse', '--checks'], project, CHECKS_TIMEOUT),
    });
  }
  if (missing.includes('map')) {
    runs.push({
      key: 'map',
      label: 'Mapping the code',
      done: 'Code map done.',
      run: () => runGlafka(bin, ['odysse'], project, MAP_TIMEOUT),
    });
  }
  return runs;
}

const CARDS: Record<string, Omit<SetupFinding, 'items'>> = {
  workspace: { key: 'workspace', title: 'glafka found how to check this project', keep: 'Keep' },
  conventions: {
    key: 'conventions',
    title: 'The code scan proposed conventions',
    keep: 'Keep all',
  },
};

// What `glafka odysse --list` says is waiting for you: one card per section.
export async function setupFindings(bin: string, project: string): Promise<SetupFinding[]> {
  const out = await runGlafka(bin, ['odysse', '--list'], project, LIST_TIMEOUT);
  const found: SetupFinding[] = [];
  let open: SetupFinding | null = null;
  for (const line of `${out.stdout}\n${out.stderr}`.split('\n')) {
    const head = /^--- \d+ (convention|workspace setting)/.exec(line);
    const card = head ? CARDS[head[1] === 'convention' ? 'conventions' : 'workspace'] : null;
    const item = /^\s+\d+\.\s+(?:\[[^\]]+\]\s+\([^)]*\)\s+)?(.+)$/.exec(line);
    if (card) found.push((open = { ...card, items: [] }));
    else if (open && item?.[1]) open.items.push(item[1]);
    else open = null;
  }
  return found.filter((f) => f.items.length > 0);
}

export function keepFinding(bin: string, project: string, key: string) {
  const flag = key === 'conventions' ? '--keep' : '--workspace-keep';
  return runGlafka(bin, ['odysse', flag, 'all'], project, LIST_TIMEOUT);
}

// Change: what the main chat is asked. A turned-down setting is parked first, so it is not kept.
export async function changeFinding(bin: string, project: string, key: string): Promise<string> {
  if (key === 'conventions')
    return 'Run `glafka odysse --list`. Ask me which conventions to keep, one question per category. Then run `glafka odysse --keep <the ones I picked>`.';
  await runGlafka(bin, ['odysse', '--workspace-keep', 'none'], project, LIST_TIMEOUT);
  return 'I turned down the check command glafka found. Ask me what this project runs for lint, typecheck and tests. Then set `checksCmd` in .glafka.json.';
}
