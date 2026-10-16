# glafka: ergon

_Commands here are written as `glafka <command>`. If the bare word does not
run, see `docs/glafka/skills/reference/invoking.md` for the fallback._

Implement a ticket's approved plan, then review the whole thing before
calling it done — test-driven, verified at every step, then reviewed as
a whole by a fresh subagent. One command, two halves.

ἔργον — work. `genesis` already runs this automatically right after a
ticket opens with an approved plan — you only need this standalone to
**resume** implementation that stopped partway (session ended, ran out
of turns, etc.), or to re-review after a fix. The review is this
command's own last step, not a separate command.

## Superpowers skills used here

**Read `docs/glafka/skills/reference/superpowers.md` before the first one.** It is the
binding rule for every row below: load the real skill file, announce it,
follow it exactly, turn its checklist into todos. A skill you write from
memory is not that skill.

| #   | Skill                                                | Half         | Why                                                                                                                                                         |
| --- | ---------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `subagent-driven-development` (or `executing-plans`) | implementing | implements the plan, one task at a time, with its own review+fix loop                                                                                       |
| 2   | `test-driven-development`                            | implementing | bundled into #1, not invoked separately — RED-GREEN-REFACTOR per task                                                                                       |
| 3   | `verification-before-completion`                     | implementing | also bundled into #1 — confirms each task actually passes before moving to the next                                                                         |
| 4   | `systematic-debugging`                               | either       | only if a test or check fails and the cause isn't obvious                                                                                                   |
| 5   | `requesting-code-review`                             | final review | **only when no reviewer is configured.** With one, `--review` spawns a separate OS process itself — see step 3; a fresh process is already a fresh reviewer |
| 6   | `receiving-code-review`                              | final review | how you evaluate the findings that come back — real technical judgment, not agreement                                                                       |

Read the rows this way:

- **Row 1 is required.** It is the implementation loop.
- **Rows 2 and 3 you get by running row 1.** Don't invoke them separately.
- **Rows 4, 5 and 6 are conditional** — and required the moment their
  condition holds. A failed check with no obvious cause means row 4, not a
  guess. Findings coming back means row 6, not agreement.

Conditional never means optional. If a skill won't resolve under either
name, say so out loud rather than improvising a replacement.

**Don't invoke `using-git-worktrees` here.** This ticket's worktree
already exists — `genesis` created it, with its own ports and (if
configured) database. A second worktree-creation skill would collide
with it, not help it.

**The app is already running.** A ticket's worktree starts its own app, on
its own ports, when the ticket is provisioned — and `ergon` brings it back
if it stopped. Don't start a second copy; the ports are taken. The prompt
names the ports, and `glafka vima <ticket-id> --restart` restarts it.

A project with nothing to run (a library, a CLI) has no `devCmd` in
`docs/glafka/architecture/isolation.json`, and none of this applies.

## 1. Get the prompt

```bash
glafka ergon <ticket-id>
```

Its stdout is the brief — the plan, plus TDD and per-step verification
instructions, and the ticket's worktree path stated explicitly. Work
inside that one directory only — cd there first if you aren't already.
If it errors (no plan on this ticket), stop and report why.

## 2. Implement

**Spawn the prompt from step 1 as a background subagent, using your
platform's own subagent/background-task mechanism.** This is the default
action, not something to reach for only when convenient — the prompt
already carries TDD, per-step verification, and (once implementation is
done) the final self-review and fresh-reviewer dispatch. From spawn to
"stop and report," nothing here needs you to drive it — see
`.claude/agents/glafka-coder.md`.

On Claude Code, that mechanism is the Agent tool:

```
Agent(subagent_type="glafka-coder", run_in_background=True, prompt=<the prompt from step 1>)
```

Don't wait on it — return control; check on it later in this session or a
new one.

**The subagent has to say when it stops.** glafka did not spawn it, so it
has no process to watch — a run dispatched this way is marked started and
nothing ever marks it ended on its own. One of these three closes it, and
the coder's prompt already asks for all three:

| The coder...                     | closes the run with                 |
| -------------------------------- | ----------------------------------- |
| finished and wants the diff read | `ergon <ticket-id> --review`        |
| is blocked and needs a person    | `aporia <ticket-id> --reason "..."` |
| stopped for any other reason     | `ergon <ticket-id> --finished`      |

If none of them runs, `poreia` shows that coder as "running" for good and
every later command on the ticket has to warn its way past it. You can run
`ergon <ticket-id> --finished` yourself to clear one whose agent went away.

**Record what you decide, as you decide it.**

```bash
glafka apofasi <ticket-id> "<what you decided, and why>"
```

A choice the plan did not make for you, an option you ruled out, something
you learned that the plan got wrong — one line each, while it is still
fresh. A project-wide rule is `psyche`, not this.

A line already under `## Person decisions` is settled. If you cannot follow
one, stop and say so with `aporia` rather than working around it.

## Stopping a run you started

```bash
glafka ergon <ticket-id> --stop            # the coder
glafka ergon <ticket-id> --review --stop   # this round's reviewers
```

**Use this instead of `kill`.** A signalled agent never writes an exit
code, so a hand `kill` in another terminal leaves exactly the evidence a
crash leaves — and `poreia` then reports your deliberate stop as
`crashed`, with the same weight as a real failure. Going through
`--stop` is what records the difference; the ticket reads
**`stopped by you`**, not `crashed`.

`--review --stop` stops **every** reviewer the round dispatched. Stopping
one of two would leave the round waiting on the other for good.

It only signals runs glafka spawned itself. A run you dispatched by hand
is not glafka's to signal — close that one with `--finished`.

**The same call, per harness** — the shape and the non-blocking behavior
both differ:

| Harness       | Native call                                                                                                               | Non-blocking?                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Claude Code   | `Agent(subagent_type="glafka-coder", run_in_background=True, prompt=<prompt>)`                                            | yes                                                                         |
| Kimi Code CLI | `Agent(subagent_type="glafka-coder", run_in_background=true, prompt=<prompt>)` — check later with `TaskList`/`TaskOutput` | yes                                                                         |
| Cursor        | `/glafka-coder <prompt>` (or natural language)                                                                            | only if the `glafka-coder` subagent's own config sets `is_background: true` |
| Gemini CLI    | `@glafka-coder <prompt>`                                                                                                  | **no — blocks until the subagent finishes**                                 |
| OpenCode      | `@glafka-coder <prompt>`                                                                                                  | **no — core has no async subagent dispatch yet**                            |

Gemini CLI and OpenCode have a subagent call, but it blocks — there is no
"spawn and immediately get control back" option in either today. On those
two, treat this the same as "no equivalent subagent call available" just
below: do the work in this session yourself, rather than waiting on a call
that was never going to return early.

**The `glafka-coder` subagent itself is defined on 5 harnesses** (not GitHub Copilot),
same ground rules everywhere (worktree-only, TDD, commit-per-step, never
push/open a PR):

| Harness        | Definition file                                                  | Known gap                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code    | `.claude/agents/glafka-coder.md`                                 | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Gemini CLI     | `.gemini/agents/glafka-coder.md`                                 | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Cursor         | `.cursor/agents/glafka-coder.md`                                 | schema has no per-tool allowlist, only a `readonly` switch — "no web tools" is a house rule in the prompt, not enforced by Cursor itself. `guardrails --install-hook` enforces shell, file reads and MCP calls (`beforeShellExecution`/`beforeReadFile`/`beforeMCPExecution`). **It does NOT enforce writes.** Cursor has no before-write hook, so the `filesystem` layer cannot keep a coder inside its worktree here at any level — `afterFileEdit` only records the write in the audit log after it lands. |
| OpenCode       | `.opencode/agent/glafka-coder.md`                                | — (`webfetch: deny` is real enforcement, not just a house rule)                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Kimi Code CLI  | `.kimi-code/agents/glafka-coder.yaml` + `glafka-coder-system.md` | **no auto-discovery** — must run with `kimi --agent-file .kimi-code/agents/glafka-coder.yaml`, or register it under your own agent config's `subagents:` field, before `subagent_type="glafka-coder"` resolves to anything                                                                                                                                                                                                                                                                                    |
| GitHub Copilot | none                                                             | **no `glafka-coder` agent ships for Copilot.** Run the prompt in this session — the same-session path below.                                                                                                                                                                                                                                                                                                                                                                                                  |

If your platform's agent has none of this wired (or is a harness not in
this table at all), fall through to the same-session path below.

Your platform's agent has no equivalent subagent call available? Invoke
`superpowers:subagent-driven-development`, or
`superpowers:executing-plans` where subagents aren't available (bare names
on harnesses without the prefix), with the plan from the prompt above, in
this session instead — the exception, not the normal path. Load the real
file and follow it exactly. It drives TDD and verification-before-completion
at every step, with a task-scoped review + fix loop built in.

No skill/subagent mechanism available? The printed prompt already
carries the same instructions in plain text — follow it directly, or run
`GLAFKA_AGENT_CMD="claude -p --permission-mode acceptEdits" glafka ergon <ticket-id> --background` to hand it to a
fresh agent automatically (see "Running unattended" below — this is the
scripted/cron path specifically, not the native-subagent one above).

## 3. Final review — same command, one more flag

When every plan step is implemented and verified, don't stop yet. This
is the second half — the review:

```bash
glafka ergon <ticket-id> --review
```

**If this project has a reviewer configured** (`.glafka.json`'s
`agents.reviewer`, or `agents.default`, or `GLAFKA_AGENT_CMD`), this
command spawns it **itself** — a genuinely separate OS process reading
the diff (committed work only, since `branchDiff` in `src/util/git.ts` — nothing
is reset or staged), this project's own lint/typecheck/test results,
ticket text, conventions, and codebase map, with no shared context with
the session that wrote the code. That is what makes it a real review,
not a self-check, and it needs **no** `requesting-code-review` skill and
**no** `Agent` tool — a fresh shell process is a fresh subagent by
construction.

Check on it, then act on what it reports:

```bash
glafka ergon <ticket-id> --review --status
```

It reports the reviewer's own verdict — recorded by the reviewer calling
`glafka krisis <ticket-id> --verdict clean|blocking [--finding "..."]`,
the same append-only pattern `psyche` already uses for ethos.

**A clean verdict needs `--token`, and only the reviewer has one.** The
round's prompt carries a one-time token; `krisis` also checks that the
call came from the reviewer process that was given it. That is what
stops a coder marking its own work clean. So:

- **Run by hand, with no token** — the verdict is recorded and says so:
  `no matching --token for this review round — recorded, but not trusted
as a clean verdict on its own`. It does **not** unblock `epistle`.
- **A `blocking` verdict never needs a token.** Anyone may raise a
  problem; only clearing one is restricted.
- **The reviewer died before recording anything?** Don't hand-write a
  clean verdict — it will not be believed. Either review again, or push
  deliberately with `epistle <id> --unreviewed`, which is recorded on
  the ticket as exactly what it was.

**No reviewer configured?** The command falls back to printing the brief
to stdout instead — you have no way to spawn a fresh reviewer yourself
in this case either, so stop here and hand the brief to whoever is
running this ticket (a human, or an orchestrating session with its own
subagent mechanism).

If a check failed (from the brief's or the reviewer's own findings) and
the cause isn't obvious, invoke `superpowers:systematic-debugging` (bare
`systematic-debugging` on harnesses without the prefix) to
root-cause it before deciding it's a real blocking finding.

Any failing check, either way, is an automatic blocking finding.

## 3b. Acceptance criteria after a clean review — epalitheusis

ἐπαλήθευσις — verification. If the spec has an `## Acceptance criteria`
section, the round is: checks → reviewer → QA. The review comes first
because it is cheaper, and its fixes would change code a QA round had
already passed. Once a recorded clean verdict covers the exact code,
`ergon --review --status` (or the next `ergon --review`) starts a fresh
**QA tester** (role `verifier`, agent from `agents.verifier`, then
`agents.default`, then `GLAFKA_AGENT_CMD`). The tester uses the running app
from outside and records one result per criterion:

    glafka epalitheusis <id> --ac AC-1 --result pass|fail|cannot --evidence "<command> → <what came back>"

`ergon --review --status` shows one line per criterion. When the round ends:

- **all pass** → done: the clean review and the criteria cover the same code.
- **a fail** → a blocking finding. Fix it and **commit**, then run
  `ergon --review`: the changed code gets a new review, then a new QA round.
- **a cannot** → the ticket stops for a person (aporia). Fix the setup and
  run `ergon --review` again, or skip that criterion.
- **the worktree changed during the round, or a pass had no token** → not
  trusted, and the ticket stops for a person. Run `ergon --review` again.

A round that ends without all passes writes a `review` entry. Only the
first entry after a coder run counts as a review round, so
`maxReviewRounds` caps the review → QA → coder loop; a retry with no coder run
in between is not counted again. A failed criterion on the last allowed
round sends no coder: no round is left to check its work. "The same code" is the code when the
round ended: a file the round itself left behind does not buy a free new
round. A failed round stays locked until it is acted on while the committed
code is the same: an uncommitted file alone does not throw the fail away, so
`--review` reports it again. A pass on uncommitted changes is not done:
commit them, or gitignore/delete them if they are generated, then
verify again.
`vima` never starts a new QA round on its own after one stopped — a person
runs `ergon --review` to start it.

A `pass` needs the round's token, like a clean `krisis`. Only the spawned
tester has it, or a person at a real terminal. With no verifier agent,
`ergon --review` shows the token only at a terminal; from an agent's shell
it prints a handover, starts nothing and exits 1. `vima` tells a person once
and then waits; it does not rerun the checks every tick. Lost that token? Run
`ergon <id> --review` again at the terminal: it starts the manual round
again with a fresh one. A person can skip one criterion, at a real terminal
only:

    glafka epalitheusis <id> --skip AC-3 --reason "<why>"

The skip lands under `## Person decisions`. The last round is then judged
again without that criterion: if everything left passed on this code, it
counts as passed and no new QA round is needed. `epistle` refuses until every
criterion left has passed on the exact code being pushed. A pass on
uncommitted changes does not count: a push sends only commits, so commit
them (or gitignore or delete them if they are generated), then verify again.
After a rebase by hand, run `ergon --review` again. `--unreviewed` does not
skip this.

No criteria in the spec → this step is skipped and nothing changes.

**The verifier command.** It must be allowed to run shell commands (curl,
the project's own CLI). For claude, `glafka install` removes the edit tools,
but a shell can still write files: only glafka's worktree check catches an
edit. A file the tester leaves in the worktree makes the whole round
untrusted. New files glafka's own checks made just before the round (a build
cache) do not count.

**QA works at guardrails levels 0–2.** At levels 3 and 4 the tester cannot
run curl, so every round ends `cannot`. `ergon --review` warns on stderr when
it starts a round there, and `vima` says it once, on the tick that starts the
tester. Use level 2 or lower for a ticket with acceptance criteria, or skip
them.

**What the gate protects against.** At the levels where QA runs (0–2) the
QA gate stops honest mistakes. It does not stop a coder that deliberately
tampers with glafka's own files, or with code the QA tester runs. Stronger
protection is a planned guardrails change.

**The app.** glafka starts the ticket's app before it starts the tester. The
tester cannot restart it: if the app does not answer, it records `cannot`.

## 4. Two outcomes

**Blocking findings** — fix them in the worktree, then re-run
`ergon <ticket-id> --review`. Loop until clean.

**Clean** — stop and report. **Raising a PR is a separate, deliberate
step, never automatic.** Nothing here pushes anything. See epistle.md —
run it only when you (or the human) actually ask for it, in this
session or a later one.

**Every file path you put in front of a person is a link.** Write it as a
clickable relative markdown link — `[docs/glafka/tickets/2026-08-07-add-dark-mode-to-settings/plan.md](docs/glafka/tickets/2026-08-07-add-dark-mode-to-settings/plan.md)`,
never a bare path. Keep trailing punctuation outside the link, or the
period gets swallowed into the URL and the link breaks.

## Ethos candidates — decided here, at the end of review

While you talk and while the ticket runs, glafka records two kinds of
proposed rule on the ticket:

- **things you said** — a preference, a decision, a correction, even an
  offhand remark, recorded in your words
- **things the agent concluded** on its own from working in the code

Neither the coder nor the reviewer records anything: both run with
nobody present, and the capture block asks for what the human said.
Everything in the pile came from `genesis` and `heureka`, where a human
was in the room, so by review time it is complete. That makes this — not
close — the moment you rule on it. After the review brief,
`ergon --review` prints whatever is awaiting a decision:

```
--- 2026-08-07-add-dark-mode-to-settings: 2 ethos candidate(s) awaiting your decision ---
  1. [ETHOS_SECURITY] (you said) never log request bodies on the ingest path
  2. [ETHOS_CODE] (agent) helpers that touch the parser stay in parser/
```

**Show that list to the human and let them pick.** An agent approving
its own proposals is not review. The `(you said)` lines are usually a
formality to confirm; the `(agent)` lines are the judgement calls.

```bash
glafka ergon <ticket-id> --review --keep all    # keep all
glafka ergon <ticket-id> --review --keep 1,3    # keep only those
glafka ergon <ticket-id> --review --keep none   # discard all
```

`--keep` decides and stops — it does not re-run the review. Kept rules
are appended under `## Learned` in `docs/glafka/ethos/`; your
hand-written `## Authored` rules there are never touched.

Once decided, `lysis` asks nothing — it only revisits candidates
recorded _after_ this ruling.

## Defining your own categories

The buckets a rule can be filed under are yours. Write
`docs/glafka/ethos/categories.json`:

```json
[
  { "name": "CODE", "hint": "naming, imports, error handling" },
  { "name": "DOMAIN", "hint": "our billing rules and invoice lifecycle" }
]
```

The `hint` is not decoration — it is the only thing telling an agent
what belongs in each bucket. Without the file, glafka uses its own ten
(code, design, architecture, testing, security, performance, ai,
workspace, technologies, infrastructure).

## Running unattended (`--background`)

This is the scripted path — cron, CI, a plain terminal with no live agent
session. There's no `Agent()` tool call possible there, so it shells out
to whatever `GLAFKA_AGENT_CMD` names instead. Distinct from, and kept
alongside, the native `glafka-coder` subagent spawn in step 2 above, which
is preferred whenever a live session is actually driving this.

```bash
GLAFKA_AGENT_CMD="claude -p --permission-mode acceptEdits" glafka ergon <ticket-id> --background
glafka ergon <ticket-id> --status
```

Keeps going after this session ends. `--status` is also the watchdog: a
run still going past `ergonTimeoutMs` (`.glafka.json`, default 60
minutes) gets killed right there and the run recorded as timed-out —
which is what makes the ticket need attention. Checking status is what
reaps a run that ran too long. `--background` runs the
**implementation** half
unattended; once it finishes clean, run `ergon <ticket-id> --review`
yourself (or script that too) to get the final review brief.

**If the user asks you to stop or cancel a background run before that**
(this session, or a later one), run:

```bash
glafka ergon <ticket-id> --stop
```

Do not use a plain `kill`. A plain `kill` looks like a crash; `--stop`
records the run as **`stopped by you`** (see "Stopping a run you started"
above). The pid file is at `.glafka/tickets/<ticket-id>/runs/coder/pid`
if you need to look.
