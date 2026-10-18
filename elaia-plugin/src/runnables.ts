import type { Runnable } from './contract';

const text = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

// Every agent under `agents`, and every value whose key ends in `Cmd` (checks, setup, the dev
// server, and keys glafka adds later), at any depth, with its path. Pure: no disk.
function glafkaRunnables(file: string, json: unknown): Runnable[] {
  const out: Runnable[] = [];
  const walk = (value: unknown, at: string[]): void => {
    const key = at.at(-1) ?? '';
    if ((at.length === 2 && at[0] === 'agents') || key.endsWith('Cmd')) {
      out.push({ file, what: at.join('.'), run: text(value) });
      return;
    }
    if (Array.isArray(value)) value.forEach((v, i) => walk(v, [...at, String(i)]));
    else if (typeof value === 'object' && value !== null)
      for (const [k, v] of Object.entries(value)) walk(v, [...at, k]);
  };
  walk(json, []);
  return out;
}

// Where glafka reads the commands it runs: its settings and the isolation profile.
export const glafkaTrust = {
  trustFiles: ['.glafka.json', 'docs/glafka/architecture/isolation.json'],
  runnables: glafkaRunnables,
};
