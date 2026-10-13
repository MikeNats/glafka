import { contextSections } from '../../memory/context.js';
import { agentInstructionFileList } from '../../memory/instructionFiles.js';
import { buildEthosCaptureSection } from '../../memory/ethos.js';
import { SPEC_TEMPLATE } from './specTemplate.js';
import type { PromptContext } from '../../types/promptContext.js';

// -------------------------------------------------------------------------- Prompt builders

// Builds only a SPEC, never a plan. The plan is a separate later step.
export function buildSpecPrompt(
  content: string,
  context: Partial<PromptContext> & { ticketId?: string; repoRoot?: string } = {},
): string {
  const sections = ['You are turning a raw idea into a spec, before any plan or code exists.'];

  // The style comes first, so it sets the tone for everything after.
  sections.push(
    ...contextSections(
      {
        ...context,
        personaIntro: 'Follow this style while asking questions and writing the spec:',
      },
      ['personaContent'],
    ),
  );

  // Only an instruction, no file content.
  // There is no worktree yet to read from.
  // Named only when the project has them. Telling an agent to read a file that
  // is not there wastes a turn and teaches it to distrust the rest of the prompt.
  const instructionFiles = context.repoRoot ? agentInstructionFileList(context.repoRoot) : '';
  if (instructionFiles) {
    sections.push(`## Project memory
Read ${instructionFiles} first — languages, conventions, and architecture live
there. Don't guess what you can read.`);
  }

  // The known rules go in here too. They matter just as much
  // while writing a spec as they do while writing code.
  sections.push(...contextSections(context, ['architectureIndex', 'ethosContent', 'proorismos']));

  sections.push(`## Raw idea\n${content}`);

  sections.push(`## Your job
Ask clarifying questions before writing anything final — don't assume you
understood a vague idea correctly. The requester may not know this codebase
well, or may not have thought every edge case through; guide them, don't
just interrogate them.

**STOP HERE and wait for the requester's answers.** Do not read the codebase
looking for an approach, and do not draft the spec yet, even as a "starting
point" — investigating or drafting before they've answered is exactly the
failure mode this step exists to prevent. Ask, then wait. Only once they've
responded should you move on to the sections below.`);

  sections.push(`## Acceptance criteria — once the requester agrees with the approach
Once the requester agrees with the approach, write the acceptance criteria
with them, before you write the spec:

1. Read the code for how a user reaches this change: routes, CLI flags,
   and ports (docs/glafka/architecture/isolation.json).
2. Show one list:
   - the requester's own criteria, if they gave any, rewritten to one line each
   - criteria you suggest, each marked "suggested"
   - questions about gaps: empty input, no login, bad input, errors
3. Wait. They keep, change, or drop each one.
4. Refuse a criterion that cannot be checked by running the app ("code is
   clean", "uses module X"). Say why, and offer one that can be checked.
5. Nothing to run at all (no devCmd, no CLI)? Say so: every criterion would
   end as "cannot check".

One criterion per line: \`- AC-<n>: <start state> → <action> → <what you see>\`.
Build checks (lint, typecheck, tests) are not criteria — review runs them.
Before any reviewer reads the diff, a fresh QA agent checks each criterion
against the running app.`);

  const categories = context.categories ?? [];
  if (context.ticketId && categories.length > 0) {
    sections.push(
      buildEthosCaptureSection({ ticketId: context.ticketId, stage: 'brainstorming', categories }),
    );
  }

  sections.push(`## Output
Once questions are resolved, write the spec. This is what a reviewer will
later check the finished code against — be as concrete as you'd want if you
were the one implementing this cold. A plan comes next, as a separate step —
don't write one here.

Write it in this shape:

\`\`\`markdown
${SPEC_TEMPLATE}
\`\`\``);

  return sections.join('\n\n') + '\n';
}

// -------------------------------------------------------------------------- Prompt builders

// Turns an approved spec into a plan. It is kept apart from the spec step.
export function buildPlanPrompt(
  specContent: string,
  context: Partial<PromptContext> & { ticketId?: string } = {},
): string {
  const sections = [
    `You are turning an approved spec into an implementation plan. Do not
write any code yet — this step only produces the plan.`,
  ];

  // The plan names the files to change, so it needs the map most.
  sections.push(...contextSections(context, ['architectureIndex']));

  sections.push(
    `## Approved spec
${specContent}

## Plan — how it gets built
- Ordered steps, each one a coherent unit of work (commit-sized).
- Which existing files/functions this touches or reuses, instead of
  duplicating logic.
- Where tests get written FIRST, before the code they test — a failing
  test, then the minimal code to pass it, per step.
- What could go wrong, and how you'd know (which check would catch it).

## Shape
Use these headings, in this order. A person approves this document, and
one that looks different every time is one they have to re-learn every
time:

    # <title> — Implementation Plan

    **Goal:** one sentence — what is true once this ships
    **Architecture:** what gets touched and why, not how
    **Tech Stack:** what it is built with; say so plainly if nothing is new

    ## Global Constraints
    - what must stay true throughout

    ## Task 1: <name>

    **Files:**
    - Create/Modify: <path>

    **Interfaces:** what this task produces for later tasks

    - [ ] **Step 1: <name>**
      what to do, and the exact command that proves it

    ## Manual verification
    anything a person has to run by hand, and what they should see

Every step is a \`- [ ]\` checkbox, so progress is trackable. Repeat
\`## Task N\` as many times as the work needs.`,
  );

  const categories = context.categories ?? [];
  if (context.ticketId && categories.length > 0) {
    sections.push(
      // The last stage with a human in the room, so it is the last one that
      // records anything. Everything after it runs unattended.
      buildEthosCaptureSection({
        ticketId: context.ticketId,
        stage: 'planning',
        categories,
        last: true,
      }),
    );
  }

  sections.push(
    `## Output
Write the plan only. Keep it concrete enough that someone unfamiliar with
this idea could follow it step by step.${
      context.ticketId
        ? `

Write it to \`docs/glafka/tickets/${context.ticketId}/plan.md\`. That is where
\`plan\` files it, so writing it anywhere else only moves it later.`
        : ''
    }
`,
  );

  return sections.join('\n\n');
}
