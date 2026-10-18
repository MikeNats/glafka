import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { SetupStep } from './contract';
import { runGlafka, type RunResult } from './run';
import type { SetupItem } from './setup';
import { setupFiles } from './setupFiles';

// The words and cards of glafka's setup, and its one commit.

const run = promisify(execFile);
export const PERSONA_TIMEOUT = 60_000;

// A step's result in words: its own line, or why it failed with the output's last lines.
export function said(r: RunResult, ok: string, failed: string): string {
  if (r.code === 0) return ok;
  const tail = `${r.stdout}\n${r.stderr}`.trim().split('\n').slice(-12).join('\n');
  return tail ? `${failed}\n\n\`\`\`text\n${tail}\n\`\`\`` : failed;
}

export const missingOf = (items: SetupItem[]) => items.filter((i) => !i.done && !i.optional);

export function startText(project: string, items: SetupItem[]): string {
  const lines = items
    .filter((i) => !i.done)
    .map((i) => `- ${i.optional ? '⚪' : '❌'} ${i.label}${i.optional ? ' (optional)' : ''}`);
  return [`**Set up ${path.basename(project)} for glafka?**`, '', ...lines].join('\n');
}

// "run checks with: npm run check" shows the command in code font.
export const line = (item: string) => {
  const at = item.indexOf(': ');
  return at < 0 ? `- ${item}` : `- ${item.slice(0, at)}: \`${item.slice(at + 2)}\``;
};

// The persona glafka writes with now, and the ones it has. Null when glafka cannot say.
export async function personas(bin: string, project: string) {
  const out = await runGlafka(bin, ['prosopon'], project, PERSONA_TIMEOUT);
  if (out.code !== 0) return null;
  const active = /^active:\s*(.+)$/m.exec(out.stdout)?.[1]?.trim() ?? '(none)';
  const names = /^available:\s*(.+)$/m.exec(out.stdout)?.[1]?.split(',') ?? [];
  const available = names.map((n) => n.trim()).filter((n) => /^[\w.-]+$/.test(n));
  return { active: active === '(none)' ? null : active, available };
}

export const personaAsk = (available: string[]): SetupStep => ({
  kind: 'ask',
  id: 'persona',
  text: "**How should glafka write its answers?**\n\nA persona sets the style of glafka's replies, reviews and reports. Change it later with `glafka prosopon`.",
  choices: [...available.map((n) => ({ id: n, label: n })), { id: 'none', label: 'None' }],
});

export const GUARDRAILS: SetupStep = {
  kind: 'ask',
  id: 'guardrails',
  text: '**Guardrails** — not set up (optional).',
  choices: [
    { id: 'explain', label: 'Explain' },
    { id: 'skip', label: 'Skip' },
  ],
};

// One commit with only setup's own files, so tickets see them. Anything else stays out.
export async function commitSetup(project: string): Promise<string | null> {
  const files = setupFiles(project);
  if (files.length === 0) return null;
  const git = (args: string[]) => run('git', args, { cwd: project });
  try {
    await git(['add', '--', ...files]);
    await git(['commit', '-q', '-m', 'Set up glafka', '--only', '--', ...files]);
    return `Setup committed (${(await git(['rev-parse', '--short', 'HEAD'])).stdout.trim()}).`;
  } catch (err) {
    const why = err instanceof Error ? err.message.split('\n').slice(-3).join(' ') : String(err);
    return `The setup commit failed: ${why}`;
  }
}
