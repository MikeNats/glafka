import type { SetupReply, SetupStep } from './contract';
import { runGlafka } from './run';
import { setupPrompt, setupStatus } from './setup';
import {
  commitSetup,
  GUARDRAILS,
  line,
  missingOf,
  personaAsk,
  personas,
  said,
  startText,
} from './setupCards';
import { setupFiles } from './setupFiles';
import { autoSetup, setupFindings } from './setupSteps';

// glafka's setup, as Elaia's setup-next and setup-answer: one question at a time. The plugin
// keeps no memory: what comes next follows from your answers and the repo's files.

export interface SetupAsk {
  answers: Record<string, string>;
  go: boolean;
  platform: string;
}

const DONE: SetupStep = { kind: 'done' };
const STOP: SetupStep = { kind: 'stop' };
// Projects whose no-agent steps ran in this setup: a failed code map is not tried at each step.
const ranAuto = new Set<string>();

// The no-agent steps (find the check command, map the code): once per setup.
async function runAuto(bin: string, project: string, out: string[]): Promise<void> {
  if (ranAuto.has(project)) return;
  ranAuto.add(project);
  const missing = setupStatus(project)
    .filter((i) => !i.done)
    .map((i) => i.key);
  for (const step of autoSetup(bin, project, missing))
    out.push(said(await step.run(), step.done, `${step.label} failed.`));
}

const end = (project: string, out: string[], step: SetupStep): SetupReply => {
  ranAuto.delete(project);
  return { said: out, step };
};

// What setup does next. `out` holds lines already said in this call.
export async function setupNext(
  bin: string,
  project: string,
  ask: SetupAsk,
  out: string[] = [],
): Promise<SetupReply> {
  const { answers } = ask;
  if (answers.start === 'skip') return end(project, out, STOP);
  const items = setupStatus(project);
  if (!ask.go && answers.start !== 'yes') {
    // Nothing to do: Elaia says nothing. Otherwise ask before anything changes.
    if (missingOf(items).length === 0 && setupFiles(project).length === 0)
      return end(project, out, DONE);
    const choices = [
      { id: 'yes', label: 'Set up' },
      { id: 'skip', label: 'Skip' },
    ];
    return {
      said: out,
      step: { kind: 'ask', id: 'start', text: startText(project, items), choices },
    };
  }
  if (!items.find((i) => i.key === 'installed')?.done) {
    const r = await runGlafka(bin, ['install', ask.platform], project, 600_000);
    out.push(said(r, 'glafka installed.', `glafka install failed (exit ${r.code}).`));
    if (r.code !== 0) return end(project, out, STOP);
  }
  if (!('persona' in answers)) {
    const found = await personas(bin, project);
    if (found && !found.active && found.available.length > 0)
      return { said: out, step: personaAsk(found.available) };
  }
  await runAuto(bin, project, out);
  const finding = (await setupFindings(bin, project)).find((f) => !(f.key in answers));
  if (finding) {
    const text = [`**${finding.title}**`, '', ...finding.items.map(line)].join('\n');
    const choices = [
      { id: 'keep', label: finding.keep },
      { id: 'change', label: 'Change' },
    ];
    return { said: out, step: { kind: 'ask', id: finding.key, text, choices } };
  }
  const missing = missingOf(setupStatus(project)).map((i) => i.key);
  if (missing.length > 0 && !('missing' in answers))
    return { said: out, step: { kind: 'agent', id: 'missing', prompt: setupPrompt(missing) } };
  const guard = setupStatus(project).find((i) => i.key === 'guardrails');
  if (guard && !guard.done && !('guardrails' in answers)) return { said: out, step: GUARDRAILS };
  const committed = await commitSetup(project);
  if (committed) out.push(committed);
  return end(project, out, DONE);
}
