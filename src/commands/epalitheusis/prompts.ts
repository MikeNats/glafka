import crypto from 'node:crypto';
import { glafkaCli } from '../../util/cli.js';
import { portsLine } from '../../util/portsLine.js';
import { contextSections } from '../../memory/context.js';
import type { Criterion } from '../../ticket/criteria.js';
import type { Ticket } from '../../types/ticket.js';

// A person reads the QA report, so style applies. It must never touch a result or its evidence.
const VERIFY_PERSONA_INTRO = `This shapes ONLY the text a person reads: your final answer. It never
changes a result, a command you run, or the --evidence you record: those stay exact.

Follow this style:`;

// The QA tester's brief. Only the spawned copy carries the token,
// so a pasted brief can never record a trusted pass.
export function buildVerifyPrompt({
  ticketId,
  criteria,
  worktree,
  ports,
  cli = 'glafka',
  token = null,
  personaContent = null,
}: {
  ticketId: string;
  criteria: Criterion[];
  worktree: string;
  ports: string | null;
  cli?: string;
  token?: string | null;
  personaContent?: string | null;
}): string {
  const record =
    `${cli} epalitheusis ${ticketId} --ac <AC-n> --result pass|fail|cannot ` +
    `--evidence "<command> → <what came back>"${token ? ` --token ${token}` : ''}`;
  const sections = [
    `You are a QA tester. You test ticket ${ticketId} from OUTSIDE, like a user.`,
    `## Acceptance criteria\n${criteria.map((c) => `- ${c.id}: ${c.text}`).join('\n')}`,
    `## Where the app is
Worktree: \`${worktree}\`
${ports ? `Ports: ${ports}` : 'No ports are reserved for this ticket. If it is a CLI, run it from the worktree.'}
If the app does not answer, record \`cannot\` with what you saw.`,
    `## Rules
1. Reach the app only through curl, the CLI, or the browser.
2. Read code only to FIND a route or a flag. Never to decide a result.
3. Make the start state yourself, through the app.
4. A pass means you ran a command and saw the result. Put both in --evidence.
5. Check exactly what the criterion says. Nothing more.
6. Do not edit, create, or commit files in the worktree. glafka compares the
   worktree before and after, and any change makes the whole round untrusted.
7. Put every scratch file (cookie jars, downloads, screenshots, logs) outside the worktree,
   under \`$TMPDIR\`, or \`/tmp\` if it is unset: \`curl -c "\${TMPDIR:-/tmp}/cookies.txt" ...\`
8. Evidence before claims: follow the \`verification-before-completion\` skill if you have it.`,
    `## Record one result per criterion
    ${record}

- pass: you saw exactly what the criterion says.
- fail: you saw something else. Say what you saw.
- cannot: you could not check it at all (the app does not start, nothing to call). Say why.

Quote --evidence as one argument. Never start --evidence with '--'.
Record every criterion, then stop. Do not fix anything.`,
    ...contextSections({ personaContent, personaIntro: VERIFY_PERSONA_INTRO }, ['personaContent']),
  ];
  return sections.join('\n\n') + '\n';
}

export interface VerifyPrepared {
  token: string;
  criteria: Criterion[];
  // New files glafka's own checks made just before this round. Not the coder's change.
  checkMade: string[];
  // `prompt` is printed for a person; only `verifierPrompt` carries the token.
  prompt: string;
  verifierPrompt: string;
}

export function prepareVerify({
  ticket,
  repoRoot,
  criteria,
  checkMade = [],
  personaContent = null,
}: {
  ticket: Ticket;
  repoRoot: string;
  criteria: Criterion[];
  checkMade?: string[];
  personaContent?: string | null;
}): VerifyPrepared {
  if (!ticket.worktree) throw new Error(`ticket ${ticket.id} has no worktree — nothing to verify`);
  const token = crypto.randomBytes(16).toString('hex');
  const base = {
    ticketId: ticket.id,
    criteria,
    worktree: ticket.worktree,
    ports: portsLine({ port: ticket.port, isolationPorts: ticket.isolationPorts }),
    cli: glafkaCli(repoRoot),
    personaContent,
  };
  return {
    token,
    criteria,
    checkMade,
    prompt: buildVerifyPrompt(base),
    verifierPrompt: buildVerifyPrompt({ ...base, token }),
  };
}
