import { portsLine } from '../../util/portsLine.js';
import { contextSections } from '../../memory/context.js';
import type { Ticket } from '../../types/ticket.js';
import type { PromptContext } from '../../types/promptContext.js';
import type { CheckResult } from '../../types/checks.js';

// -------------------------------------------------------------------------- Prompt builders

// The style applies only to the final report, never to code.
// Nobody is watching, and the plan is already approved.
const ERGON_PERSONA_INTRO = `This shapes ONLY text a person will read — your final report, and the
reason you give if you have to stop. It does NOT apply to code, comments,
commit messages, test names, or identifiers: those follow this codebase's
own conventions, whatever this style says.
Sections come from these instructions; wording comes from the style.
Never add, drop, or reorder a section because of it.

Two overrides, because nobody is watching this run:
- Do not ask the requester questions. There is no one to answer them.
- Do not offer alternative approaches. The plan below is already approved;
  if it turns out to be wrong, say so once and stop.

Follow this style:`;

// These fields are optional here, even though a real ticket always has
// them. Tests pass only an id and rely on the defaults.
type ErgonPromptTicket = Pick<Ticket, 'id'> &
  Partial<Pick<Ticket, 'worktree' | 'specText' | 'port' | 'isolationPorts'>>;

export function buildErgonPrompt({
  ticket,
  planContent,
  // What was decided after the plan was approved. Null when nothing was.
  decisionsContent = null,
  checksCmd = null,
  e2eCmd = null,
  alreadyDone = [],
  resumeNote = null,
  context = {},
  // True only for a background run. It must not be told to review itself,
  // because we still see its own process as running.
  background = false,
  // How THIS agent can invoke glafka. See src/util/cli.ts: the bare word is not reliably runnable from
  // a spawned agent, and every command below is a verb the agent has no other way to reach.
  cli = 'glafka',
  // The resolved guardrails level. 0 means nothing is enforced, so there is no claim to make.
  // Null means the caller did not resolve it — treated as "there may be a cage", the safe way round.
  guardrailsLevel = null,
  // Whether this ticket's app is up right now. False by default, so a project
  // with nothing to run is never told about an app it does not have.
  devRunning = false,
}: {
  ticket: ErgonPromptTicket;
  planContent: string;
  decisionsContent?: string | null;
  checksCmd?: string | null;
  e2eCmd?: string | null;
  alreadyDone?: string[];
  resumeNote?: string | null;
  context?: Partial<PromptContext>;
  background?: boolean;
  cli?: string;
  guardrailsLevel?: number | null;
  devRunning?: boolean;
}): string {
  const {
    id: ticketId,
    worktree: worktreePath = null,
    specText: spec = null,
    port = null,
    isolationPorts = null,
  } = ticket;

  // Read twice below: once by the section saying the app is up, once by the
  // rules about which ports this ticket may use.
  const ports = portsLine({ port, isolationPorts });

  const sections = [`You are implementing the approved plan for ticket ${ticketId}.`];

  // FIRST, before anything else. If you are a subagent inside someone's own session, glafka cannot
  // tell your tool calls from theirs: your cwd is theirs, you carry no GLAFKA_TICKET_ID, and a
  // shell command has no file path to read a ticket out of. With nothing to go on, the guardrails
  // hook has to assume you are the human and skips every check. Running this is
  // what ties this session to this ticket. At level 0 this step cannot pass — no hook, no marker —
  // and it ends in "stop". No cage asked for is not a cage gone missing. Only
  // the second is worth stopping over.
  if (!background && guardrailsLevel !== 0) {
    sections.push(`## Do this first
Before any other tool call, run:

    ${cli} guardrails --claim ${ticketId}

This tells glafka's guardrails hook that this session's work belongs to
ticket ${ticketId}. Until it runs, glafka cannot tell your tool calls apart
from the human's, so **none of the guardrails apply to you** — you would be
working uncaged without either of you being told.

If it prints \`NOT claimed\`, say so and stop. Do not carry on uncaged.`);
  }

  if (worktreePath) {
    sections.push(
      `## Where to work\nYour worktree is at \`${worktreePath}\` — cd there first if you aren't already. Every file you read, write, or run belongs inside this one directory; nothing else should change.`,
    );
  }

  // The prompt already named the ports, but never said anything was listening
  // on them, so a coder had no reason not to start its own copy.
  if (devRunning) {
    sections.push(`## The app is running
This ticket's app is already up, on its own ports — nothing to start.
${ports ? `\n${ports}\n` : ''}
Its output is in the log, and \`${cli} vima ${ticketId} --restart\` brings it
back if it stops. Do not start a second copy: the ports are taken by the one
that is already running.`);
  }

  // Say this before the plan, so a coder that resumes does not redo work.
  if (alreadyDone.length > 0) {
    sections.push(
      `## Already done (${alreadyDone.length} commit(s) since the plan was approved)\n` +
        alreadyDone.map((s) => `- ${s}`).join('\n') +
        `\n\nRead this before starting. Do not redo a step that is already committed. ` +
        `If a step looks half-done, finish it rather than restarting it.`,
    );
  }
  if (resumeNote) {
    sections.push(`## Read this first\n${resumeNote}`);
  }

  // No goal section here, because the plan already covers it.
  sections.push(
    ...contextSections({ ...context, personaIntro: ERGON_PERSONA_INTRO }, [
      'personaContent',
      'architectureIndex',
      'codeGraph',
      'projectMemory',
      'ethosContent',
    ]),
  );
  if (spec) sections.push(`## Original ticket (what was asked for)\n${spec}`);

  sections.push(`## Plan\n${planContent}`);

  // After the plan, on purpose. plan.md is the snapshot of what was agreed;
  // these are what was settled since, so where they disagree these win.
  if (decisionsContent) {
    sections.push(
      `## Decisions taken since the plan was approved\n${decisionsContent}\n` +
        `These were settled after the plan was written. Where one contradicts a\n` +
        `plan step, the decision wins — the plan is not rewritten. A line under\n` +
        `"Person decisions" is settled: if you cannot follow it, stop and say so\n` +
        `rather than working around it.\n\n` +
        `Record your own decisions as you go:\n\n` +
        `    ${cli} apofasi ${ticketId} "<what you decided, and why>"`,
    );
  }

  const envLine = ports
    ? `- **Your ports for this ticket:** ${ports}
  These are in \`.env.glafka\` in your worktree, along with anything else this
  project's setup produced for you (a database connection string, for example).
  Load that file before you start a server, run a migration, or run the app.
  Never use this project's normal default ports — another ticket may hold them.`
    : `- This worktree has a \`.env.glafka\` file holding whatever this project's
  setup reserved for this ticket. Load it before you start a server, run a
  migration, or run the app, rather than using this project's normal defaults.`;

  // Full checks once, at the end: after every step they cost a turn each, and their output is
  // re-read on every later turn. The step's own tests still give the test-first feedback.
  const stepTestsLine = `- Verify before moving on: after each step, run only the tests for that
  step (the test files it wrote or changed) and see them pass. Do not run
  the full checks after every step, even where a plan step says to — the
  full checks run once, below. A claim with no evidence is not verification.`;
  const verifyLine = checksCmd
    ? `${stepTestsLine}
- When every step is done, run the full checks ONCE and see them exit 0 —
  \`${checksCmd}\`${e2eCmd ? ` (e2e is separate: \`${e2eCmd}\`, only if the change needs it)` : ''}.
  Do not substitute your own command. Fix every failure, then run it again
  until it passes. This passing IS the definition of done — not "looks
  right", not a claim with no evidence.`
    : `${stepTestsLine}
- When every step is done, run this project's own full checks ONCE
  (tests, lint, whatever it actually uses — no \`checksCmd\` is
  configured for this project, so there is no single command to hand
  you; find the real one). Fix every failure, then run them again until
  they pass.`;

  // Named, not paraphrased. A skill written from memory is not the skill, and
  // the bullets under this one are only the fallback when none can be loaded.
  const skillsLine = `- **Use the real skills if you can load one.** Work the plan through the
  \`executing-plans\` skill, which bundles \`test-driven-development\` and
  \`verification-before-completion\` — so don't invoke those two separately.
  When a check fails and the cause isn't obvious, load \`systematic-debugging\`
  rather than guessing. Not \`subagent-driven-development\`: you have no
  subagent to dispatch to. Some harnesses namespace these as
  \`superpowers:<name>\`; try that form first, then the bare name. Announce
  each skill as you start it and follow it as written — don't write your own
  version from memory. If none of them load, say so once, then follow the
  bullets below: they are the same instructions in plain text.`;

  sections.push(`## How to work
${skillsLine}
${envLine}
- Test-driven: for each step, write a failing test first, then the
  minimal code to pass it. No production code without a failing test
  that justifies it.
${verifyLine}
- Commit after each step passes. This is not bookkeeping: the review that
  follows reads \`git diff base...HEAD\` — anything you leave uncommitted
  is invisible to it and gets reviewed as if you never wrote it.
- If a step reveals the plan is wrong, or you hit something the plan did
  not account for and cannot safely resolve yourself — say so and STOP,
  don't silently improvise around it. Record it before you stop:

      ${cli} aporia ${ticketId} --reason "<what the plan got wrong, or what's blocking you>"

  This is what tells whoever picks this ticket back up that it needs a
  human decision, not another attempt — a coder that quietly gives up
  looks identical to one that finished, unless this is recorded.

  **If you cannot run that command** — no shell, the command is not
  available, permission never arrives — then say it in your own final
  answer instead, as the very last line you write, bare, with nothing
  after it:

  STUCK: <what the plan got wrong, or what's blocking you>

  glafka reads that line back and records the same impasse. Do it either
  way. Stopping silently is the one outcome nobody can act on.`);

  // No ethos capture here. The block asks the agent to record what the human
  // said, and no human is present while a coder runs.

  sections.push(
    background
      ? `## Output
When every step is done and verified, stop here — do not run
\`${cli} ergon ${ticketId} --review\` yourself. Your own process is still
the one glafka considers "running" until it exits, so that command would
see its own still-live run and refuse, every time.

Once you stop — by finishing normally, or by recording
\`${cli} aporia ${ticketId} --reason "..."\` if you had to — whatever is
driving this ticket (glafka's own unattended loop, or a human) reviews it
next, and glafka spawns a fresh reviewer itself if one is configured.
Pushing is a separate, later decision made after that — nothing here does
that automatically.`
      : `## Output
When every step is done and verified, don't stop yet — run
\`${cli} ergon ${ticketId} --review\` yourself. It reads everything you
have committed against the base branch (nothing is reset or staged) and
runs this project's checks.

If this project has a reviewer configured, **glafka spawns it itself** —
a genuinely separate process with no shared context with you, which is
what makes it a real review and not a self-check. You do not need a
\`requesting-code-review\` skill or an \`Agent\` tool for this; glafka
does not need either one either. Check on it with
\`${cli} ergon ${ticketId} --review --status\` and act on what comes back.

If the spec has acceptance criteria, they are checked after the review
comes back clean, against the running app: once the verdict is clean,
\`--review --status\` starts a fresh QA tester when a verifier agent is
configured, or else prints a handover for a person at a real terminal.
\`--review --status\` shows each criterion:
a failed one is a blocking finding.

If no reviewer is configured, the command prints the review brief
instead — you have no way to spawn a fresh reviewer yourself, so stop
here and hand the brief to whoever is running this ticket.

Any failing check, in the brief or in a reviewer's findings, is an
automatic blocking finding.

Blocking findings: fix them here, then run \`${cli} ergon ${ticketId} --review\`
again. Clean: stop and report. Pushing is a separate, later decision —
nothing here does that automatically.

**If you stop for any other reason** — not reviewing, not blocked enough
to record an aporia — say so before you go:

    ${cli} ergon ${ticketId} --finished

glafka did not spawn you, so it has no process to watch: without one of
\`--review\`, \`aporia\` or \`--finished\`, this run stays marked "running"
forever and every later command on the ticket has to warn its way past
it.`,
  );

  // "Clean: stop and report" was the whole specification of a report, so every run invented its
  // own. One real report buried "the review never ran" in fourth place, under two sections of
  // detail — a person had to read it all to learn they had to act.
  sections.push(
    `## The report itself

Use this shape, every time. A person reads this to decide what to do
next, and a report that looks different every run is one they have to
re-read from scratch.

\`\`\`
**Status:** done · blocked · partly done — one line, and the first line.

**Blocked on** — only when blocked. What is stuck, and who has to act.
Nothing goes above this section.

**Changed**
- \`path/to/file.ts\` — what changed, one line each

**Evidence**
| check | before | after |
- one line per proof that is not a check result

**Off-plan** — anything done differently from the approved plan, and
why. Write "nothing" if there was none. Never leave it out.

**Not done** — what was in scope and did not happen.

**Found, not fixed** — problems seen on the way and deliberately left
alone. One line each.
\`\`\`

- **Status first, blocker second.** Someone must learn they have to act
  before they read what changed. Detail never sits above a blocker.
- **Off-plan and "found, not fixed" are required.** A plan deviation
  buried in prose is one nobody approved, and a known problem left
  unwritten is one that goes quiet. "nothing" is a fine answer; dropping
  the heading is not.
- **Separate failures that were already there** from ones you caused. A
  baseline taken before you wrote anything is the only honest way to
  report a suite that is already red.`,
  );

  return sections.join('\n\n') + '\n';
}

// Limits output from a check that prints too much.
// 200 lines is enough for a normal error trace.
const MAX_CHECK_OUTPUT_LINES = 200;

// Past this, a truncated copy stops being trustworthy — a reviewer told
// nothing would read a partial diff as the whole thing, and the omitted
// files were the least-reviewed part of every ticket that hit this limit.
// So past here we point the reviewer at git instead of pasting a partial
// diff: it already runs inside the worktree with shell access, and reading
// the real diff itself costs nothing a truncated copy was saving anyway.
const MAX_DIFF_LINES = 4000;

// Named for the reviewer, so it knows to skip these when it reads the
// diff itself — the least useful, highest-volume part of most diffs.
const GENERATED_PATH_NAMES = [
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'Cargo.lock',
  'poetry.lock',
  'go.sum',
  'composer.lock',
  'dist/',
  'build/',
  'vendor/',
  'node_modules/',
];

// The diff section of the review prompt. Small diffs go in whole — a
// reviewer reading them inline is simpler than sending it back to git for
// something that already fits. Past MAX_DIFF_LINES, embedding always cost
// either a truncated diff (files silently missing from review) or a prompt
// too large for the reviewer to accept at all — this fix removes the diff
// from the prompt's size entirely, so `baseRef` is required to build the
// exact command that reads the same thing `git diff` computed here.
function diffSection(diff: string, baseRef: string | null): string {
  const trimmed = diff.trim();
  if (trimmed === '') return '## Diff under review\n```diff\n(no staged changes)\n```';

  const lines = trimmed.split('\n');
  if (lines.length <= MAX_DIFF_LINES) {
    return `## Diff under review\n\`\`\`diff\n${trimmed}\n\`\`\``;
  }

  // No baseRef means no command to hand the reviewer — the only thing left
  // that still works is the old truncate-and-embed, as a fallback of last
  // resort rather than the normal path.
  if (!baseRef) {
    const body = lines.slice(0, MAX_DIFF_LINES).join('\n');
    return (
      `## Diff under review\n\`\`\`diff\n${body}\n\`\`\`\n\n` +
      `… THIS DIFF IS PARTIAL. ${lines.length - MAX_DIFF_LINES} more line(s) were cut to keep ` +
      `the review readable.`
    );
  }

  return `## Diff under review
This diff is ${lines.length} lines — too large to paste here without either
truncating it (some files silently missing from review) or pushing this
prompt past what you can accept. Read it yourself instead:

    git diff --stat ${baseRef}...HEAD
    git diff --submodule=diff ${baseRef}...HEAD

Run both in this worktree. Skip generated files if either command shows
them (${GENERATED_PATH_NAMES.join(', ')}) — they are noise, not the change.`;
}

// The review checklist, as plain text.
const CHECKLIST = `## 1. Acceptance criteria
Does the diff actually do what the original ticket asked for? List anything
asked for that's missing, and anything the diff does that nobody asked for.

## 2. Code quality
- Follows the patterns already used elsewhere in this codebase?
- Reuses existing functions/modules instead of duplicating logic?
- Follows this codebase's naming conventions?
- Check the automated checks above — do lint/typecheck/test actually pass?
  A failure there is a blocking finding, not a style note.
- Violates anything in the project rules above? A rule is in force the same
  way a check is: a violation is a blocking finding, not a style note. If a
  rule looks wrong, say that in the finding — do not skip it silently.
- Holds up as the codebase grows — no hardcoded one-off assumptions?
- Has real test coverage for the new behavior, not just the happy path?

## 3. Security
- Any injection risk (SQL, shell, command, template)?
- Any secret, credential, or token hardcoded or logged?
- Any missing authorization/ownership check on the new code path?
- Any unsafe deserialization, unbounded input, or path traversal?

## 4. Anything else
Anything else a careful reviewer would flag on a pull request.`;

// A second reviewer only earns its cost by looking somewhere the first one does not. This one reads
// the diff as a shape, not as lines: it is sent only when a diff is large enough that no single
// reviewer holds all of it at once, which is exactly when structure goes wrong unnoticed.
const ARCHITECTURE_CHECKLIST = `## 1. Where this change landed
Are these the right files and modules for this change? Say so if something
belongs somewhere else, and name where.

## 2. Boundaries
- Does this cross a layer it should not (a route reaching into storage, a
  pure module importing an adapter, a helper knowing about a caller)?
- Does it duplicate a concept that already exists under another name?
- Does it add a new way to do something this codebase already does one way?

## 3. Project rules
- Does this break any project rule above about layering, boundaries, or
  where things live? A violation is a blocking finding.
- Does it set up a pattern that will make an existing rule impossible to
  keep later?

## 4. Shape of the change
- Is this one change, or several unrelated ones sharing a branch?
- Would a reader six months from now find this where they would look for it?
- Does it leave the codebase easier or harder to change next time?

## 5. What it costs later
Anything here that will be expensive to undo: a new dependency, a new
persisted shape, a public signature, a pattern others will copy.

You are NOT the line-by-line reviewer — another reviewer is reading this
same diff for correctness, security and tests. Do not repeat that work. If
you find nothing structural, say so plainly: that is a real answer, and a
padded finding costs more than it is worth.`;

// Which context blocks each kind of reviewer is worth paying for. A large diff can earn more than
// one reviewer, and handing each of them the same full block multiplies the token cost without
// adding any reading. So the map goes to whoever is actually reading for structure: one reviewer →
// it gets everything, including the map. There is no duplication to avoid, and dropping the map
// would cost quality in the common case for no saving at all. two reviewers → the architecture
// reviewer takes the map; the general one keeps the conventions. Neither pays for the other's.
// `standards` and `reviewDoc` appear here and nowhere else: they are the long form, and the coder
// prompt above deliberately does not ask for them.
const CONTEXT_FOR_KIND: Record<string, string[]> = {
  general: [
    'personaContent',
    'architectureIndex',
    'codeGraph',
    'projectMemory',
    'ethosContent',
    'standards',
    'reviewDoc',
  ],
  'general-paired': [
    'personaContent',
    'codeGraph',
    'projectMemory',
    'ethosContent',
    'standards',
    'reviewDoc',
  ],
  // The rules go to this reviewer too. The ARCHITECTURE and DESIGN
  // categories are its own subject, and it used to never see them.
  //
  // No `standards` here on purpose. The lanes are line-by-line work ending in five verdict lines,
  // and this reviewer is explicitly told not to repeat the line-by-line pass — two reviewers each
  // returning their own five verdicts is a conflict nobody can resolve. It still gets `reviewDoc`,
  // because a project's own document is where its layering rules usually live.
  architecture: [
    'personaContent',
    'architectureIndex',
    'codeGraph',
    'projectMemory',
    'ethosContent',
    'reviewDoc',
  ],
};

const CHECKLIST_FOR_KIND: Record<string, string> = {
  general: CHECKLIST,
  'general-paired': CHECKLIST,
  architecture: ARCHITECTURE_CHECKLIST,
};

// Say "UNVERIFIED" loudly when nothing ran, so it never reads as a pass.
function formatChecks(checks: CheckResult[], checksNote: string | null = null): string {
  if (checks.length === 0) {
    return (
      `**NONE RAN — this diff is UNVERIFIED. Do not treat this as a pass.**\n\n` +
      `${checksNote ?? 'no checks were run for this ticket.'}\n\n` +
      `Anything you would normally let a test prove, you must confirm by reading ` +
      `the code. State plainly in your findings that no automated check ran.`
    );
  }
  return checks
    .map((c) => {
      // Output from a passing check adds nothing, so skip it.
      if (c.passed) return `### ${c.name}: PASSED`;
      // Neither pass nor fail. Say that clearly instead of showing a failure.
      const heading = c.unknown ? `${c.name}: UNVERIFIED` : `${c.name}: FAILED`;
      // Keep the end, not the start. The reason usually sits at the end.
      const lines = c.output.trim().split('\n');
      const tail = lines.slice(-MAX_CHECK_OUTPUT_LINES).join('\n');
      const truncated =
        lines.length > MAX_CHECK_OUTPUT_LINES
          ? `… (${lines.length - MAX_CHECK_OUTPUT_LINES} earlier line(s) omitted)\n`
          : '';
      return `### ${heading}\n\`\`\`\n${truncated}${tail}\n\`\`\``;
    })
    .join('\n\n');
}

// A person reads the findings, so style applies. It must never cost us the
// file, the line, or the reason.
const REVIEW_PERSONA_INTRO = `This shapes HOW you write your findings, not what counts as one. Every
finding still needs its file, its line, and why it matters — a shorter
style must never cost a detail someone needs in order to act.
Sections come from these instructions; wording comes from the style.
Never add, drop, or reorder a section because of it.

Two overrides:
- Do not ask a question in place of stating a finding. Nobody is there to
  answer, and an unanswered question blocks nothing.
- Do not propose an alternative design in place of naming a defect. Say
  what is wrong first; a suggested fix is optional and comes after.

Follow this style:`;

// The same context blocks as the coding prompt. Missing ones are skipped.
export function buildReviewPrompt({
  ticket,
  diff,
  // The ref the diff was computed against. Only needed to build the
  // git command an oversized diff falls back to — a diff that fits inline
  // never uses it, which is why every caller that only ever sends small
  // diffs in tests can go on omitting it.
  baseRef = null,
  checks = [],
  checksNote = null,
  hostExec = null,
  reviewToken = null,
  context = {},
  kind = 'general',
  cli = 'glafka',
}: {
  ticket: Pick<Ticket, 'id' | 'specText'>;
  diff: string;
  baseRef?: string | null;
  checks?: CheckResult[];
  checksNote?: string | null;
  hostExec?: string | null;
  reviewToken?: string | null;
  context?: Partial<PromptContext>;
  kind?: string;
  cli?: string;
}): string {
  const { id: ticketId, specText } = ticket;

  const opening =
    kind === 'architecture'
      ? `You are reviewing ticket ${ticketId} for STRUCTURE — where the change landed and what it costs later, not line-by-line correctness.`
      : `You are reviewing ticket ${ticketId} the way a careful senior engineer reviews a pull request.`;

  const sections = [opening, `## Original ticket (acceptance criteria)\n${specText}`];

  sections.push(
    ...contextSections(
      { ...context, personaIntro: REVIEW_PERSONA_INTRO },
      CONTEXT_FOR_KIND[kind] ?? CONTEXT_FOR_KIND.general!,
    ),
  );

  sections.push(diffSection(diff, baseRef));
  // Reviewers re-ran these anyway and paid a turn for each, or hit a refusal and retried.
  const ranNote =
    checks.length > 0
      ? `\n\nglafka ran these on this exact code just before you started. Do not run\nthem again — read the result above.`
      : '';
  sections.push(`## Automated checks\n${formatChecks(checks, checksNote)}${ranNote}`);
  // These files run on a person's machine, not the agent's.
  // Point that out if it could be a problem.
  if (hostExec) sections.push(`## Runs on the human's machine, not in the cage\n${hostExec}`);
  // The built-in checklist is the fallback, not an addition. A project that seeded the standards
  // folder gets the five lanes instead — sending both would put two checklists in one prompt, each
  // ending in a different verdict shape, and the reviewer would have to guess which one counts.
  // The architecture reviewer keeps its own checklist either way: the lanes are line-by-line work,
  // which is the one thing that reviewer is told not to repeat.
  const laneStandards = kind !== 'architecture' && context.standards;
  if (!laneStandards) {
    sections.push(`## Review checklist\n${CHECKLIST_FOR_KIND[kind] ?? CHECKLIST}`);
  }

  // No ethos capture here either. A reviewer runs with nobody watching, so
  // there is no human preference for it to record.

  const tokenFlag = reviewToken ? ` --token ${reviewToken}` : '';
  sections.push(`## Output
List findings most severe first: file, line (if applicable), what's wrong,
why it matters. Any failing check above is an automatic blocking finding.
If there is nothing wrong, say so plainly — do not invent findings to look
thorough.

**Report each finding through the CLI, as you find it — don't wait until you
are done:**

\`\`\`
${cli} krisis ${ticketId} --verdict blocking --finding "<file>:<line> — <what's wrong>"${tokenFlag}
\`\`\`

One call per finding. If there is nothing wrong, call it once with
\`--verdict clean\` and no \`--finding\`${reviewToken ? `, keeping the same \`--token ${reviewToken}\`` : ''}.
${
  reviewToken
    ? `\nThe \`--token\` value above is this review round's own — it is what tells glafka this verdict actually came from a fresh read of the diff, not from the ` +
      `same process that wrote it. Copy it exactly; a clean verdict without it is recorded but not trusted as the round's real outcome.\n`
    : ''
}

**Then, regardless of whether the command above is available to you, end your
own final answer with ONE line, on its own, as the very last thing you write.
Write it bare — no code fence, no bold, no bullet, nothing after it.** One of:

VERDICT: clean
VERDICT: blocking — <the single most severe reason, in one line>

This is not optional and not just for you — it is what glafka reads back if
the \`krisis\` command could not run in your environment (a sandboxed run at
a strict guardrails level cannot reach it), so silence here would look
exactly like "nobody ever reviewed this diff", not like "clean". Say it
either way, even if you already called \`krisis\`.`);

  return sections.join('\n\n') + '\n';
}
