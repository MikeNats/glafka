import type { Category } from '../../types/promptContext.js';
import { flagOf } from '../../memory/categories.js';
import { agentInstructionFileList } from '../../memory/instructionFiles.js';

// -------------------------------------------------------------------------- Prompt builders

// This part costs money, because an agent has to read real code.

// One block per category. It tells the agent which command to run. It used to name the ethos FILES
// and tell the agent to edit them. That was the only place in glafka where something other than the
// CLI wrote ethos, and a file the agent edits directly cannot be guarded.
function ethosSection(categories: readonly Category[], cli: string, repoRoot: string): string {
  const instructionFiles = agentInstructionFileList(repoRoot);
  const width = Math.max(...categories.map((c) => flagOf(c).length));
  const lines = categories
    .map((c) => `  ${cli} odysse --propose ${flagOf(c).padEnd(width)} "<rule>"   # ${c.hint}`)
    .join('\n');

  return `

## Also: what conventions does this codebase already follow?

You are reading every file anyway. While you do, notice the rules this project
already lives by — the things a new contributor would get wrong on day one
because nobody wrote them down.

Record each one with its own command, as you find it. Do not edit any file
under \`docs/glafka/ethos/\` yourself — the command owns those files, drops
duplicates, and keeps decided rules safe:

${lines}

One rule per command, on one line. Run the command the moment you spot the
convention, rather than collecting them up for the end.

If a convention only holds in part of the codebase, say where, and it is
only ever sent to work that touches those files:

  ${cli} odysse --propose --code "[scope: **/migrations/**] <rule>"

Leave the scope off when it applies everywhere. Most do.

What to report:
- Only patterns you can point at in real code, followed consistently. Two
  files agreeing is a coincidence; every file agreeing is a convention.
- Phrase it as an instruction a future contributor can follow, not as an
  observation about what you saw. "Errors are wrapped at the boundary, never
  mid-call" — not "I noticed error wrapping".
- Skip anything already stated${instructionFiles ? ` in ${instructionFiles} or` : ''} under
  \`## Authored\` — it is already in force, and a duplicate is noise.
- Skip anything the language or framework already forces. A rule nobody could
  break is not a convention.
- If a category has nothing worth reporting, run no command for it. Reporting
  nothing is a correct answer and far better than a padded list.

A human rules on these before any of them take effect, so err toward reporting
a real pattern you are unsure is intentional over staying silent — but do not
invent one to fill a category.

On a re-run this project may already hold rules from an earlier scan. Run the
command anyway: a rule that is already known is dropped and reported back to
you, and rules a human has already ruled on are never touched.`;
}

// Builds the whole-repo prompt. Run it once, or when the docs feel old.
// It also gathers rules, since the agent is reading every file anyway.
export function buildOdysseFullPrompt({
  tree,
  repoRoot,
  categories = [],
  // The invocation THIS agent can run. See src/util/cli.ts — every command below is a verb the scan has
  // no other way to reach, and `--propose` is how the conventions it spots are captured at all.
  cli = 'glafka',
}: {
  tree: string;
  repoRoot: string;
  categories?: readonly Category[];
  cli?: string;
}): string {
  const ethosBlock = categories.length === 0 ? '' : ethosSection(categories, cli, repoRoot);
  return `You are creating a hierarchical map of this codebase, so future
work can orient quickly instead of re-reading everything from scratch.

## File tree
${tree}

## Your job
For each meaningful directory (skip build output, generated files, etc.):
- Read the files in it.
- Write what it does, in plain terms.
- Note key exports/functions and what calls what, if that matters.
- Note the business logic — WHY this exists, not just what the code says.
- Link to child directory docs if it has subdirectories with their own doc.

## Using glafka

Every glafka action you take goes through the commands shown in this prompt.
That is the only sanctioned surface, and there are two rules about it.

- **Never read, import or call anything under \`.glafka/\`.** That is glafka's
  own vendored code. It is there so the commands run, not for you to use. The
  functions in it write the very files a person is supposed to approve first,
  so calling one directly writes rules with nobody's approval behind them.
- **If a glafka command fails, stop and say so.** Do not find another way to
  get the same result. A broken command is worth one line at the end and
  costs nothing; routing around it silently writes data no one checked, and
  nobody ever finds out.

## Output
One doc per meaningful directory, saved under
${repoRoot}/docs/glafka/architecture/, mirroring the real directory
structure. Start with a top-level
${repoRoot}/docs/glafka/architecture/README.md that lists every major
area and links to its doc — this is the entry point; a reader should be
able to skim this one file and know where to drill in.

## Also: how does this project run, in isolation?

Every future ticket gets its own git worktree — a full, independent
checkout. Figure out what it takes to actually RUN this project from one
of those, in parallel with other tickets' worktrees, without anything
colliding.

Investigate for real, don't guess: read \`docker-compose.yml\`,
\`package.json\` scripts (\`dev\`/\`start\`/\`test\`/\`e2e\`/anything that
starts something), \`.env\` files, and any database config (Prisma schema,
migration scripts, etc). Find the actual ports and the actual database
connection mechanism — grep for hardcoded port numbers and env var names,
don't take a README's word for it if the real scripts disagree with it.
If files disagree with each other, trust whatever the real dev script
actually runs over anything just documented.

Record variable NAMES only — never copy an actual value out of a \`.env\`
file into \`isolation.json\` or any architecture doc. Both are permanent,
git-tracked files; a real secret pasted into either is a leak, not
documentation.

Only write the file below if this project has something worth isolating
(an actual dev server and/or a database). A library or CLI with nothing
to run needs none of this — skip it entirely rather than inventing
services that don't exist.

Write \`${repoRoot}/docs/glafka/architecture/isolation.json\` — plain code
reads this on every future ticket (no LLM involved at that point), so the
cost of this investigation is paid once here, not once per ticket:

\`\`\`json
{
  "services": [
    { "name": "<short id, e.g. \\"db\\">", "envVars": ["<REAL_ENV_VAR_NAME>"] }
  ],
  "setupCmd": "<shell command>",
  "seedCmd": "<shell command that fills the database setupCmd just made>",
  "wakeCmd": "<shell command that brings those services back if they have stopped>",
  "teardownCmd": "<shell command>",
  "devCmd": "<shell command that starts the whole app>",
  "healthCmd": "<shell command, exit 0 when the app is ready>",
  "e2e": {
    "services": [ "... same shape, only for resources e2e tests need that dev doesn't ..." ],
    "setupCmd": "<shell command>",
    "teardownCmd": "<shell command>"
  }
}
\`\`\`

- One service per independently-portable thing (frontend, backend,
  database, a separate worker — whatever this project actually has).
- **\`envVars\` is a port-assignment list, not a list of things the service
  needs.** Every name you put there is literally set to that service's
  reserved port number — \`FOO\` in the list means the worktree gets
  \`FOO=4137\`. So list ONLY names whose correct value is a bare port
  integer. Put two names on one service only when both must hold that same
  port (e.g. a backend read as both \`PORT\` and \`SERVER_PORT\`).
  Never list an API key, password, URL, hostname, or database name — a
  \`DATABASE_URL\` in \`envVars\` becomes \`DATABASE_URL=4137\`, which is
  worse than useless. Those belong in \`setupCmd\`'s \`KEY=VALUE\` output.
- \`setupCmd\` MUST use the ports it is handed in its environment. Do not
  compute your own ports (hashing the ticket id, adding an offset, etc.) —
  glafka picked those by actually binding them and by avoiding every other
  open ticket's ports. A self-derived port silently defeats both.
- \`setupCmd\`/\`teardownCmd\` are plain shell, run from the new worktree.
  Each envVar name above is a real environment variable when they run
  (e.g. \`$DB_PORT\`), plus \`$GLAFKA_TICKET_ID\` — no templating syntax,
  just real env vars. \`setupCmd\` provisions whatever this project needs
  (e.g. a docker container per ticket for its database) using those ports
  instead of this project's normal hardcoded defaults. \`teardownCmd\`
  undoes it (e.g. removing that container).
- \`setupCmd\` may also print extra \`KEY=VALUE\` lines to stdout for
  anything it derives — e.g. a full \`DATABASE_URL\` built from the
  reserved db port and this project's normal db name/credentials. Those
  get merged in too, so a ticket's worktree ends up with a real,
  immediately-usable connection string, not just a bare port number.
- \`seedCmd\` runs straight after \`setupCmd\`, from the worktree, and it sees
  every \`KEY=VALUE\` line \`setupCmd\` printed — so a \`$DATABASE_URL\` derived
  there is a real environment variable here. Find it the way you find any other
  command: the migration/seed script this project already has (\`prisma db seed\`,
  \`rails db:seed\`, \`make seed\`, a \`seed\` npm script). **Run it and prove it
  works** before writing it, exactly like \`checksCmd\` — a seed that fails leaves
  half-filled tables, and provisioning fails rather than hand a coder a database
  nobody can trust. Omit it if this project has no seeding; an empty database is
  a fine answer when it is the true one.
  Not the same thing as \`workspace.seedFiles\`, which copies gitignored FILES in.
- \`wakeCmd\` runs before **every** coder run, so it must be safe when nothing is
  wrong — \`docker start <name>\` on a container that is already up exits 0 and does
  nothing, which is exactly the shape wanted. Not \`docker run\`, which would fail on
  the second call. glafka cannot ask whether these services are up, so it does not
  check: it just runs this. Name the same container \`setupCmd\` created, using
  \`$GLAFKA_TICKET_ID\` — this gets \`setupCmd\`'s environment, so anything it printed
  is a real variable here too. Omit it if this project's services cannot stop, or if
  there are none. A ticket's database really does die, and a coder handed a dead one
  does not see a dead database — it sees its own work failing.
- \`devCmd\` starts the WHOLE app in one command — the script this project
  already uses (\`pnpm dev\`, \`docker compose up\`, \`turbo dev\`). Not one
  command per service. It runs from the worktree, with every reserved port
  already in its environment, and it must stay in the foreground: a command
  that forks and exits looks to glafka like an app that died immediately.
  Leave it out entirely for a library or a CLI with no app to run.
- \`healthCmd\` is optional and exits 0 once the app is really serving — e.g.
  \`curl -sf localhost:$PORT/health\`. Leave it out unless this project has a
  real readiness endpoint. Without one, glafka waits for the reserved ports to
  be listening, which needs no configuration and is right for most projects.
  Do not invent an endpoint you have not seen in the code.
- Only include \`"e2e"\` if e2e tests actually need something dev doesn't
  (e.g. a separate clean/seeded database) — don't invent a section that
  just duplicates the dev one.
- If this project's own setup is already broken or inconsistent in ways
  that would make an isolation profile built on it wrong (dead services,
  contradicting port numbers across files), say so in your final report
  instead of encoding the inconsistency into the profile.

## Also: what does it take to make a fresh worktree of this project runnable?

\`isolation.json\` above covers external resources (ports, databases). This
covers the checkout itself. \`git worktree add\` produces a bare checkout —
for many projects that is already enough, and then you write nothing here.
It is NOT enough when the project has submodules, needs a dependency
install, or depends on files that are gitignored.

Run commands to find this out. Do not infer it from documentation:

- **Base branch** — \`git symbolic-ref refs/remotes/origin/HEAD\`. Do not
  assume \`main\`; plenty of repos are on \`master\` or something else, and
  cutting from a branch that doesn't exist fails every ticket.
- **Submodules** — \`git ls-files -s | grep ^160000\` lists the real ones.
  Cross-check against \`.gitmodules\`, but trust the index: \`.gitmodules\`
  records intent and goes stale, so it can name paths that were later
  inlined as ordinary files or never added at all. Passing such a path to
  \`git submodule update\` aborts the whole command.
- **Dependency install** — find the lockfile and the package manager that
  matches it. Prefer the frozen/CI form (\`--frozen-lockfile\`, \`ci\`, etc).
- **Local-only files** — \`.env\` and friends that are gitignored, so a
  fresh worktree gets none of them and the project cannot boot.

Write \`${repoRoot}/docs/glafka/architecture/workspace.proposed.json\`
containing ONLY the fields that actually apply — omit the rest, don't write
nulls. A human reviews this and approves it into \`isolation.json\`:

\`\`\`json
{
  "baseRef": "<the branch tickets should be cut from>",
  "submodules": { "paths": ["<real gitlink path>"], "branchPerTicket": false },
  "bootstrapCmd": "<dependency install, run from the worktree root>",
  "seedFiles": ["<gitignored path to copy from the main checkout>"]
}
\`\`\`

- \`seedFiles\` lists PATHS ONLY. The file contents are copied at ticket
  time; never transcribe a secret into this file, it is git-tracked.
- \`branchPerTicket: true\` only if a ticket would realistically need to
  commit inside a submodule. It leaves them on a branch instead of detached.
- \`bootstrapCmd\` gets \`$GLAFKA_REPO_ROOT\`, \`$GLAFKA_WORKTREE\` and
  \`$GLAFKA_TICKET_ID\` in its environment, plus the reserved ports.
- If nothing here applies, skip the file entirely.

**Not your job here: finding how this project runs its checks.** That is
\`${cli} odysse --checks\`, a separate focused run. glafka itself tests what it
finds, once a person keeps it. glafka prints that as the next step when you stop, so
you do not have to; just do not guess a \`checksCmd\` from a manifest or lockfile.

## Things you find that are not the map

You will notice things while reading: a bug, dead code, a security hole,
something that is plainly wrong. Write each one in the doc for the directory it
lives in, and carry on reading.

- **Never stop the scan to ask about one.** Discovery runs start to finish. The
  only reason to run a scan this long is to walk away from it, and one question
  in the middle takes that away.
- **Severity is not a reason to stop.** A serious finding is written down and
  raised at the end, the same as every other one.
- **Do not offer to fix it.** odysse maps a codebase, it does not change one.
  What you found is a ticket for later, and saying so is enough.
- The only thing that may stop the scan is something that blocks the scan
  itself — the repo will not read, the tree is not what this prompt says. That
  is an obstacle, not a finding.

## How to write: update, don't regenerate

This may be a re-run over docs that already exist. If so, read what's there
first and treat it as the baseline:

- Edit a doc in place where reality has moved. Leave a doc that is still
  accurate exactly as it is — an unchanged file is the correct outcome, not
  a skipped one.
- Create only what is genuinely missing.
${ethosBlock}

## What to print while you work

A whole-codebase scan runs long. The only thing a human should see while it runs
is one checklist, redrawn in place as items finish — not a word besides.

- Write the plan out as a checklist before you open a single file. One item per
  area you will map, plus one each for the top-level README, \`isolation.json\`
  and \`workspace.proposed.json\`. Five to ten items. Forty is its own kind of
  noise, so group small directories together rather than listing every one.
- Keep it current as you go, in whatever task list your harness has that
  redraws in place. Tick items off as they finish.
- **If your harness has no such list, print nothing at all.** A checklist that
  is printed rather than redrawn is fifteen copies of itself by the end, which
  is worse than silence. There is nothing useful to say in the middle of a scan.
- Never write progress as prose. No "now moving on to", no "so far I have".

## What to print when you stop

The files are the deliverable. glafka reads them back off disk and prints
the run's report itself — how many docs were written, whether
\`isolation.json\` landed, every convention and workspace setting awaiting a
decision, and the next command. **Do not write your own version of it.**

- Never restate a doc's contents in the terminal. It is already in the file.
- No closing commentary. The checklist above was the whole progress view, and
  it is finished by now.
- If you fanned out to subagents, their reports are working notes for you,
  not output for the human. Do not relay them, and do not merge them into a
  report of your own.
- The only thing worth printing is something that is NOT in any file and
  changes what the human should do next — e.g. this project's own setup
  contradicts itself, so the profile you wrote stands on shaky ground.
  Five lines, maximum. If there is nothing like that, print nothing.

Then, after every decision above is settled and nothing else is left, offer the
findings you held back: say how many there are and where they are written, and
ask whether they want to go through them now. One question, at the very end. If
they say no, the findings are in the docs and that is the end of it.`;
}

// Finds how this project runs its checks. The agent does not run it: glafka
// does, when a person keeps it at a real terminal.
export function buildChecksProbePrompt({ repoRoot }: { repoRoot: string }): string {
  return `Find the command that runs this project's own checks — lint,
typecheck and tests. That is the whole job. Do not write
architecture docs, and do not change any source file.

## Why this matters
glafka runs this command itself after an agent finishes a ticket, and refuses
to call the work verified without it. Today it has nothing configured, so every
ticket is recorded as UNVERIFIED. One correct command here fixes that
permanently.

## Investigate for real — do not assume an ecosystem
Read whatever this project actually uses. It may be any language. Look for the
real entry points, in this order of trust:

1. **CI config** — \`.github/workflows/*\`, \`.gitlab-ci.yml\`, \`Jenkinsfile\`,
   \`azure-pipelines.yml\`. This is the most reliable source in any repo,
   because it is the command that actually gates merges. Start here.
2. **A task runner** — \`Makefile\`, \`justfile\`, \`Taskfile.yml\`, \`noxfile.py\`,
   \`tox.ini\`. A \`make test\` target beats reconstructing the underlying call.
3. **The language's own manifest** — whatever this project has:
   \`package.json\`, \`pyproject.toml\`, \`Cargo.toml\`, \`go.mod\`,
   \`build.gradle\`, \`pom.xml\`, \`mix.exs\`, \`Gemfile\`, \`*.csproj\`,
   \`composer.json\`, \`deno.json\`, \`pubspec.yaml\`, \`CMakeLists.txt\`.
4. **The README's contributing section** — trust it least. If it disagrees with
   CI, CI is right and the README is stale.

If this is a monorepo or multi-package workspace, find the command that runs
checks across **all** of it, not one package. Read the real workspace config to
learn which tool drives it — do not infer the tool from a lockfile alone.

A workspace root usually has **no \`test\` script of its own**, and that is the
case that used to end with nothing being run at all. The member packages are
named for you — \`workspaces\` in the root \`package.json\` (an array, or
\`{ "packages": [...] }\`), or \`packages:\` in \`pnpm-workspace.yaml\`. Read that
list, open each member's manifest, and see which ones define checks. Then find
the ONE command that runs them together and prove it. A per-package loop is the
last resort, not the first answer, and \`npm test\` inside each folder is almost
never what this project really uses.

## Do NOT run it
You run with nobody watching, so do not execute what you found. glafka runs it
itself, once, when a person keeps it at a real terminal, and shows them the
result. Read the real config instead, so the command you write is the one this
project really uses — not a guess from a lockfile.

- If it needs dependencies installed first, note that separately — a bootstrap
  step is a different field, and glafka already has one.

Prefer the cheapest command that still covers lint + typecheck + tests. If they
are separate commands, join them with \`&&\`. Keep e2e OUT of it — that goes in
its own field, because it is slow and needs services running.

## Output
Write \`${repoRoot}/docs/glafka/architecture/workspace.proposed.json\`.

The file may already exist from a previous \`odysse\` run. If so, **read it and
add these keys**, leaving every other key exactly as it is — do not rewrite the
file from scratch and do not drop findings someone else made.

\`\`\`json
{
  "checksCmd": "<the command you found>",
  "e2eCmd": "<only if this project has real end-to-end tests, else omit>"
}
\`\`\`

Omit a key entirely rather than writing a null or a guess. A human approves
these before anything uses them.

## Report back
State, in plain terms: the command and where you found it. If you could not find one, say that plainly — "this project
has no automated checks" is a real and useful answer, and far better than an
invented command.`;
}

// Only updates the folders a ticket touched, so the cost fits the change.
export function buildOdysseUpdatePrompt({
  changedPaths,
  tree,
  repoRoot,
  treeRoot = repoRoot,
  // What actually changed, bounded. Without it this prompt handed over a list of PATHS, so the only
  // way to learn what a change did was to open each file whole — and an agent that has just read a
  // file whole edits the doc for that file whole. The diff makes the CHANGE the unit of work.
  diff = null,
}: {
  changedPaths: string[];
  tree: string;
  repoRoot: string;
  treeRoot?: string;
  diff?: string | null;
}): string {
  const changedBlock = changedPaths.length === 0 ? '(no files changed)' : changedPaths.join('\n');
  // No ```diff fence here: `boundedDiff` fences its own body, and past its size ceiling what comes
  // back is instructions for reading the diff rather than the diff itself.
  const diffBlock =
    diff && diff.trim() !== '' ? `\n## What the change actually did\n${diff}\n` : '';
  const readFilesNote =
    treeRoot === repoRoot
      ? ''
      : `\n## Where to read the changed files\n${treeRoot} — NOT ${repoRoot}. The tree below was scanned\nfrom there: this ticket's branch is pushed but not merged, so anything it\nadded or changed only exists in that checkout.\n`;

  return `This ticket changed these paths:
${changedBlock}
${diffBlock}
## File tree of the affected areas only
${tree}
${readFilesNote}
## Where the docs live
${repoRoot}/docs/glafka/architecture/ — the project's permanent copy, not
inside any ticket's worktree.

## Your job
Update ONLY the architecture docs for directories these paths belong to.
Don't re-scan the rest of the codebase — it hasn't changed. If a new
top-level directory was added, also add one line for it in
${repoRoot}/docs/glafka/architecture/README.md's index.

## Scope — read this before you edit
Work from the diff. Edit ONLY the sentences it makes wrong. Anything still
accurate stays exactly as it is, word for word — no rewording, no
reordering, no retitling, no tidying, no "while I'm here". Open a source
file only when the diff genuinely does not tell you what a change did.
"Nothing to change" is a correct and common answer: say it and stop. You
are not here to improve the docs, only to stop them being wrong.

## Output
Edit the existing doc file(s) in place. If a doc doesn't exist yet for a
touched directory, create it — same shape as the rest: what it does, key
exports, business logic. Keep a new one short; it can grow when someone
needs it to.
`;
}
