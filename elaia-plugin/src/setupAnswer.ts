import type { SetupReply } from './contract';
import { runGlafka } from './run';
import { setupPrompt, type SetupKey } from './setup';
import { PERSONA_TIMEOUT, personas, said } from './setupCards';
import { setupNext, type SetupAsk } from './setupFlow';
import { changeFinding, keepFinding } from './setupSteps';

const FINDINGS = new Set(['workspace', 'conventions']);

// Your answer to a setup card: glafka does the work for it, then says what is next.
export async function setupAnswer(
  bin: string,
  project: string,
  ask: SetupAsk & { id: string; choice: string },
): Promise<SetupReply> {
  const { id, choice } = ask;
  const out: string[] = [];
  if (id === 'persona' && choice !== 'none') {
    const known = (await personas(bin, project))?.available ?? [];
    if (!known.includes(choice)) out.push(`glafka has no persona called ${choice}.`);
    else {
      const r = await runGlafka(bin, ['prosopon', choice], project, PERSONA_TIMEOUT);
      out.push(said(r, `Persona: ${choice}.`, 'Setting the persona failed.'));
    }
  }
  if (FINDINGS.has(id) && choice === 'keep')
    out.push(said(await keepFinding(bin, project, id), 'Kept.', 'Keeping it failed.'));
  if (FINDINGS.has(id) && choice === 'change') {
    const prompt = await changeFinding(bin, project, id);
    return { said: out, step: { kind: 'agent', id: `${id}-change`, prompt } };
  }
  if (id === 'guardrails' && choice === 'explain') {
    const prompt = setupPrompt(['guardrails' as SetupKey]);
    return { said: out, step: { kind: 'agent', id: 'guardrails-explain', prompt } };
  }
  return setupNext(bin, project, ask, out);
}
