import { genesis } from '../genesis/genesis.js';
import { buildEthosCaptureSection } from '../../memory/ethos.js';
import { loadPromptContext, contextSections } from '../../memory/context.js';
import type { Ticket } from '../../types/ticket.js';
import type { PromptContext } from '../../types/promptContext.js';

// Like genesis, but with no plan step. Just an idea.
export async function heureka({
  repoRoot,
  stateDir,
  idea,
  name = null,
  baseRef = 'main',
  portRange = undefined,
  bootstrapTimeoutMs = undefined,
  isolationHookTimeoutMs = undefined,
  checksCmd = null,
  checksTimeoutMs = null,
  personaContent = null,
}: {
  repoRoot: string;
  stateDir: string;
  idea: string;
  // Names the ticket when the idea itself has nothing to slug.
  name?: string | null;
  baseRef?: string;
  portRange?: { start: number; end: number };
  bootstrapTimeoutMs?: number;
  isolationHookTimeoutMs?: number;
  // Passed to the checks baseline. See src/checksBaseline.ts.
  checksCmd?: string | null;
  checksTimeoutMs?: number | null;
  personaContent?: string | null;
}): Promise<{ ticket: Ticket; prompt: string }> {
  // We name the type here, because genesis() does not yet.
  // Reading and writing a ticket already promise this shape.
  const ticket: Ticket = await genesis({
    repoRoot,
    stateDir,
    content: idea,
    name,
    baseRef,
    portRange,
    bootstrapTimeoutMs,
    isolationHookTimeoutMs,
    checksCmd,
    checksTimeoutMs,
  });
  const prompt = buildHeurekaPrompt({
    ticket,
    idea,
    context: {
      ...loadPromptContext({ repoRoot, worktree: ticket.worktree }),
      personaContent,
    },
  });
  return { ticket, prompt };
}

// -------------------------------------------------------------------------- Prompt builder

// The worktree is optional here, even though a real ticket always has one.
// Tests pass only an id, and then we leave that line out.
export function buildHeurekaPrompt({
  ticket,
  idea,
  context = {},
}: {
  ticket: Pick<Ticket, 'id'> & Partial<Pick<Ticket, 'worktree'>>;
  idea: string;
  context?: Partial<PromptContext>;
}): string {
  const { id: ticketId, worktree: worktreePath = null } = ticket;
  const worktreeLine = worktreePath
    ? ` Your worktree is at \`${worktreePath}\` — cd there first if you aren't already.`
    : '';
  const sections = [
    `You are exploring an idea for ticket ${ticketId} — this is deliberately
NOT a fixed plan to implement. Brainstorm, read the real code, try
approaches, drop what doesn't work, and write real code for whatever
does. All of this happens in this ticket's own worktree, so nothing else
is affected while you explore.${worktreeLine}`,
  ];

  sections.push(
    ...contextSections({ ...context, personaIntro: 'Follow this style while exploring:' }, [
      'personaContent',
      'architectureIndex',
      'projectMemory',
      'ethosContent',
      'proorismos',
    ]),
  );

  sections.push(`## The idea\n${idea}`);

  sections.push(`## How to work
- No fixed plan to follow — that's the point. Explore, prototype, change
  direction if the first approach doesn't pan out.
- Still real code: if you land on something worth keeping, it should run
  and be testable, not just sketched.
- If the idea turns out to need real structure (a multi-step plan,
  sign-off before building) — say so and stop. That's what a fresh
  \`genesis\` ticket is for, not this one.`);

  // Same as the coder step: collect rules even from ideas we drop.
  const categories = context.categories ?? [];
  if (categories.length > 0) {
    sections.push(buildEthosCaptureSection({ ticketId, stage: 'exploring', categories }));
  }

  sections.push(`## Output
When you've either found something worth keeping or concluded the idea
doesn't pan out, stop and say which. The next step from here is review
(\`ergon --review\`), same as any other ticket.`);

  return sections.join('\n\n') + '\n';
}
