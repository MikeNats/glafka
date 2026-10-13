# glafka: genesis

_Commands here are written as `glafka <command>`. If the bare word does not
run, see `docs/glafka/skills/reference/invoking.md` for the fallback._

Create a ticket, brainstorm a spec, write a plan, get approval, then
implement and review. One approval total — the plan. **Pushing is never
automatic**: raising a PR only happens later, on a separate, deliberate
ask.

Uses [Superpowers](https://github.com/obra/superpowers) skills at the
steps below — it's genuinely cross-agent (Claude Code, Cursor, Gemini
CLI, Kimi Code, OpenCode, and GitHub Copilot CLI all install it
natively; `glafka install` printed the exact command for whichever of
those you just set up). Don't have it, or use a different skill
framework entirely? Use the agnostic path instead — same idea, no
plugin dependency:

```bash
glafka create "<idea>"                                  # ticket exists now, phase brainstorming
glafka genesis --draft <id> "<idea>"                   # spec prompt (fallback for step 2)
glafka spec <id> spec.md --title "<short summary>"  # phase spec-written
glafka genesis --plan-draft <id> "$(cat spec.md)"      # plan prompt (fallback for step 4)
glafka plan <id> plan.md                           # acquires real resources, then stops
                                                       # (add --background to go straight on into ergon)
```

`--draft`/`--plan-draft` need the id from step 1 — that's what lets `psyche`
attach anything said during brainstorming to this ticket (see step 2 below).

Check the active persona first: `glafka prosopon`. If one is set, read
`docs/glafka/personas/<name>.md`, or `.glafka/installKit/personas/<name>.md` when the
project has none of its own, and follow its style for the rest of this dialogue.

**Every file path you put in front of a person is a link.** Write it as a
clickable relative markdown link — `[docs/glafka/tickets/2026-08-07-add-dark-mode-to-settings/plan.md](docs/glafka/tickets/2026-08-07-add-dark-mode-to-settings/plan.md)`,
never a bare path. Keep trailing punctuation outside the link, or the
period gets swallowed into the URL and the link breaks.

## Superpowers skills used in this flow

**Read `docs/glafka/skills/reference/superpowers.md` before the first one.** It is the
binding rule for every row below: load the real skill file, announce it,
follow it exactly, turn its checklist into todos. Writing your own version
from memory is not invoking it.

| #   | Skill                                                | Step                         | Why                                                                                                               |
| --- | ---------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 1   | `brainstorming`                                      | 2                            | turns the raw idea into a spec through clarifying Q&A                                                             |
| 2   | `writing-plans`                                      | 4                            | turns the approved spec into a task-by-task plan                                                                  |
| 3   | `subagent-driven-development` (or `executing-plans`) | 6, and again after fix loops | implements the plan — TDD and verification-before-completion come bundled into this skill, not invoked separately |
| 4   | `requesting-code-review`                             | 6 (ergon's own final step)   | dispatches a fresh, no-shared-context reviewer                                                                    |
| 5   | `receiving-code-review`                              | 6                            | evaluating findings that come back                                                                                |

Every one is **required**, not suggested. If a skill won't resolve under
either name, say so out loud and take this flow's agnostic path above — do
not improvise a replacement.

**Don't invoke `using-git-worktrees` anywhere in this flow.** Step 6 below
already creates this ticket's isolated worktree, ports, and (if this
project has an isolation profile) its own database — a second
worktree-creation skill would collide with it, not help it.

## 1. Create the ticket

```bash
glafka create "<idea>"
```

Capture the printed `id`. The ticket exists now, phase `brainstorming` —
no worktree, branch, or port yet; those wait for step 6, after approval.
This is what gives step 2 a real, fixed file to write into from the
start, instead of a scratch draft with nowhere in particular to land.

The id is built from the idea, so the words you pass become the name of
the worktree, the branch and both docs. Two things can stop it:

- **The name is already taken.** Say what holds it and ask for different
  wording. Do not retry with a number on the end.
- **The idea has nothing to slug** — no `a-z` or `0-9` anywhere, which is
  any idea written in another alphabet. Pass a name yourself:
  `create "<idea>" --name "fix the system"`. The idea is still recorded
  as written; only the name comes from the flag.

## 2. Brainstorm

Invoke the `superpowers:brainstorming` skill (bare `brainstorming` on
harnesses without the prefix) on the idea. Load the real file and follow it
exactly — see `docs/glafka/skills/reference/superpowers.md`. It's a dialogue — ask
clarifying questions, don't just accept a vague idea and run with it.
Read this project's `CLAUDE.md`/`AGENTS.md` first if one exists, then the
codebase map at `docs/glafka/architecture/README.md` if it exists — use it to
find files instead of searching the repo.

**Stop and wait for the requester's answers before you do anything
else.** Don't investigate the codebase and don't draft the spec yet, even
as a "starting point" — that's the exact failure mode this step exists to
prevent. The spec is written to `docs/glafka/tickets/<id>/spec.md` (fixed now
that the id exists) — follow the skill's own conventions for producing
the content, but that's the path step 3 expects.

**Record ethos as you go, here too — this is the earliest point a human
can state a preference.** The id already exists (step 1), so nothing
blocks it: the moment they state a preference, make a decision, or
correct you, run `glafka psyche <id> --<category> "<what they said>"`
right then, not batched up at the end. Same rule `heureka` follows.

The category is a **flag**, not a positional argument — `--code`,
`--design`, `--testing`, and whatever else this project's
`categories.json` defines. Run `glafka psyche --help` to see the list it
accepts here. A bare `glafka psyche <id> code "…"` is refused.
Planning is the LAST stage that records anything — the coder, the
reviewer and the doc sync all run unattended, so they record nothing.

**No `--from` flag.** It is recorded as an agent-observed candidate,
which is correct — you are reporting what you heard, not certifying it,
and the human rules on it at review. `--from you` means a person typed
the rule themselves; the CLI refuses it without a real terminal, so
asking for it only earns you an error.

**Record decisions the same way, and keep them apart from ethos.** A rule
that outlives this ticket is `psyche`. A decision that shapes only this
ticket is:

```bash
glafka apofasi <id> "<what was decided>"
```

Run it the moment it is said, not batched at the end. Four things earn a
line:

- a choice that changed what gets built — _"no lat/lon input, too complicated"_
- an option that was ruled out, and why it lost
- something cut from scope on purpose
- something learned while working that the plan does not say

Two things do not: a rule that applies to the whole project (that is
`psyche`), and anything already written in `spec.md` or `plan.md`. The
test is whether a fresh session holding only those two files would get it
wrong or ask again.

**You do not choose the section.** A person typing it lands under
`## Person decisions`; an agent lands under `## Coder decisions`. That is
read off the terminal, not off a flag.

This is what makes clearing a session safe: `spec.md` and `plan.md`
survive a clear on their own, and `decisions.md` is where everything else
that was settled out loud goes.

**Use this shape when you put the design back to them.** Step 4 gives the
plan a fixed shape for the same reason: a document that looks different
every time is one they have to re-learn every time. This is the reply the
whole ticket hangs on, so it gets one too.

It is a **layout for what the skill produced**, never a substitute for
running it. Order is: run `brainstorming` → it produces the content → you
shape that content to fit below.

```markdown
## 1. <what changes> — `path/to/file.js:26`

<the code — first, before any prose>

**Why <chosen>, not <rejected>:**

- the fact that rules the alternative out
- the failure it would cause

## 2. <the guard>

<the edge case this change creates, and what handles it>

## 3. <next change>

...

**Out of scope:** named explicitly, tied back to what they chose.

Does this look right?
```

- **Code first, prose after.** Every numbered item opens with the code.
- **One numbered item per change.** Never two files under one point.
- **Always name the rejected option.** "Why X, not Y" is what shows the
  choice was made rather than defaulted into. Without it they cannot tell
  the difference.
- **Out of scope is stated, not implied.** It closes the ticket's edges,
  and it is what stops the next question being "did you also…".
- **One closing question.** Not three, and not a summary.

A persona changes how this text reads — shorter, a guiding question
first, bullets instead of prose. It never changes which sections there
are or what order they come in.

**Then the acceptance criteria — after the design is agreed.** Before you
write `spec.md`:

1. Read the code for how a user reaches this change: routes, CLI flags,
   and ports (`docs/glafka/architecture/isolation.json`).
2. Show one list: their own criteria (rewritten to one line each), the
   ones you suggest (marked "suggested"), and questions about gaps —
   empty input, no login, bad input, errors.
3. Wait. They keep, change, or drop each one.
4. Refuse a criterion that cannot be checked by running the app ("code is
   clean", "uses module X"). Say why, and offer one that can be checked.
5. Nothing to run at all (no `devCmd`, no CLI)? Say so: every criterion
   would end as "cannot check".

Before any reviewer reads the diff, `ergon --review` sends a fresh QA agent
to check each criterion against the running app — see ergon.md. No
criteria means that step is skipped.

**Write `spec.md` in this shape:**

```markdown
# <title> — spec

## Why

<the problem, in plain words>

## 1. <what changes> — `path/to/file.ts:26`

<the code — first, before any prose>

**Why <chosen>, not <rejected>:**

- the fact that rules the alternative out

## Out of scope

- <named, tied back to what was chosen>

## Acceptance criteria

- AC-1: <start state> → <action> → <what you see>
- AC-2: <start state> → <action> → <what you see>
```

## 3. Record the spec

```bash
glafka spec <id> <spec-path> --title "<short human summary>"
```

Phase is now `spec-written`. **You write `--title` here** — by now you
understand the idea; a short human summary ("Add search filters to
product list"), not a mechanical slugify of the raw request. It's what
ticket listings show from here on, alongside the id. Re-running this
before step 5 is fine — brainstorming isn't always one pass.

## 4. Write the plan

Invoke the `superpowers:writing-plans` skill (bare `writing-plans` on
harnesses without the prefix) using that spec. Load the real file and follow
it exactly — see `docs/glafka/skills/reference/superpowers.md`. It produces a plan
file — a separate document, never merged into the spec.

**Read the codebase map first** — `docs/glafka/architecture/README.md`, if it
exists. The plan names the files to change; the map says where they are.

**Run the skill to its end, including its self-review.** Its no-placeholder
scan, spec-coverage check and type-consistency check are the reason it's
here; a plan written straight to the layout below skips all three.

Two of its instructions glafka overrides, and only these two:

- **Where the file goes.** Write it to `docs/glafka/tickets/<id>/plan.md`,
  not the skill's own path. That is where `plan` files it, so anywhere
  else only moves it later.
- **How the flow ends.** The skill closes by offering an execution choice.
  glafka has one execution path — step 5 then step 6 below. Skip its
  closing menu; everything before it stands.

**Use this shape.** A person approves this document; one that looks
different every time is one they have to re-learn every time. Again: this
is the layout the skill's output goes into, not a replacement for it.

```markdown
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
```

Every step is a `- [ ]` checkbox, so progress is trackable. `plan`
warns if the plan has no `## Task` heading and no `- [ ]` step, and
refuses an empty file outright.

**Keep recording ethos here too**, same rule as step 2 — a plan review
is still a live dialogue, and a human can push back on scope right here.

## 5. User approval

**Approve the document, not a wall of chat.** Give the requester a
clickable relative link to `docs/glafka/tickets/<id>/plan.md` plus a three-line
summary — the goal, how many tasks, and what is deliberately out of
scope. Don't paste the plan body into the conversation; it is a file, and
a file is what they will come back to.

Then ask: "Start the coder on this plan? (y/n)"

Only `y` or `yes` goes on. Anything else: STOP. The ticket stays at `spec-written` —
nothing is lost, pick this back up later at step 4, or abandon it
entirely:

```bash
glafka cancel <id>
```

See cancel.md. This is the **only** approval gate in this flow — there is
no second one before pushing, because nothing here pushes.

## 6. Acquire resources and implement

On approval, hand the plan to glafka — this is the moment the worktree,
branch, and ports finally get created:

```bash
glafka plan <id> <plan-path>
```

Capture the printed `branch`, `worktree`.

**`plan` is the step that builds things.** It is not just a filing
action — it acquires this ticket's real resources:

| What                              | Note                                                                   |
| --------------------------------- | ---------------------------------------------------------------------- |
| a branch and a worktree           | under `.worktrees/<id>/`                                               |
| ports, one per service            | picked free, written to `.env.glafka` in the worktree                  |
| whatever `isolation.json` sets up | containers, a per-ticket database — via `setupCmd`                     |
| **the project's dev server**      | if `isolation.json` has a `devCmd`, it is **started and left running** |
| a checks baseline                 | so a check already red on the base branch is not blamed here           |

The dev server keeps running for the life of the ticket, on the ticket's own
port — that is deliberate, so you can look at the change while it is built.
`glafka lysis <id>` stops it. To restart it after a crash:
`glafka vima <id> --restart`. A project with nothing to run (a library, a
CLI) has no `devCmd` and gets no server.

`plan` does not print the
implementation prompt itself — fetch that separately, so its stdout is
one clean, single-purpose string with nothing else mixed in:

```bash
glafka ergon <id>
```

**Now spawn it as a background subagent, using whatever native
subagent/background-task capability your own platform gives you.** This
is the default action, not a fallback to reach for only if convenient —
from here to "stop and report" below, nothing requires you or the human
to do anything: implementation, TDD, per-step verification, the final
self-review, and dispatching a fresh reviewer subagent are all steps the
spawned subagent carries out on its own, because the prompt it was given
(the stdout above) already tells it to. The human re-enters exactly once
more after this — reviewing what comes back.

On Claude Code, that capability is the Agent tool:

```
Agent(subagent_type="glafka-coder", run_in_background=True, prompt=<the stdout above>)
```

Don't wait on it — return control; check on it later in this session or
a new one.

**Report the spawn in this shape**, using the values `plan` printed:

> Coder started for `<id>`.
>
> - port: `<port>`
> - worktree: `<worktree>`
> - branch: `<branch>`
>
> Status: `glafka poreia <id>`. Nothing is pushed yet.

One block, four facts. A ticket with no `devCmd` has no port — drop that
line rather than printing an empty one.

**The same call, per harness** — the shape and the non-blocking behavior
both differ:

| Harness       | Native call                                                                                                               | Non-blocking?                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Claude Code   | `Agent(subagent_type="glafka-coder", run_in_background=True, prompt=<prompt>)`                                            | yes                                                                        |
| Kimi Code CLI | `Agent(subagent_type="glafka-coder", run_in_background=true, prompt=<prompt>)` — check later with `TaskList`/`TaskOutput` | yes                                                                        |
| Cursor        | `/glafka-coder <prompt>` (or natural language)                                                                            | only if the`glafka-coder` subagent's own config sets `is_background: true` |
| Gemini CLI    | `@glafka-coder <prompt>`                                                                                                  | **no — blocks until the subagent finishes**                                |
| OpenCode      | `@glafka-coder <prompt>`                                                                                                  | **no — core has no async subagent dispatch yet**                           |

Gemini CLI and OpenCode have a subagent call, but it blocks — there is no
"spawn and immediately get control back" option in either today. On those
two, treat this the same as the fallback just below.

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

If your platform's agent hasn't been given an equivalent subagent
mechanism to call (or its own call blocks, per the table above), run the
prompt yourself in this session instead — this is the exception, not the
normal path. Invoke `superpowers:subagent-driven-development`, or
`superpowers:executing-plans` where subagents aren't available (bare names
on harnesses without the prefix). Load the real file and follow it exactly;
TDD and verification-before-completion are bundled into it, not invoked
separately.

**The subagent is only caged if guardrails are on.** Turn them on with
`glafka guardrails --level 2`, then `glafka guardrails --install-hook`,
then start a new agent session. Without that, the subagent still runs,
just uncaged (same as `--background` at guardrails level 0).

Scripted/unattended use (cron, CI — no live agent session to spawn a
subagent from) is the one other real exception:
`GLAFKA_AGENT_CMD="claude -p --permission-mode acceptEdits" glafka ergon <id> --background`.
See ergon.md.

**Blocking findings**: fixed by the same subagent, which re-runs
`ergon <id> --review` itself and loops until clean — no approval needed,
that's still covered by step 5. You only see this if you check on it
mid-run; by design, it isn't something you need to drive.

`glafka ergon <id>` (without `--review`) resumes
implementation standalone, for a session that ended mid-way.

## 7. Stop and report — pushing is a separate, later decision

Once `ergon <id> --review` comes back clean:

> Ticket `<id>`: implemented and reviewed.
>
> Nothing has been pushed. Raising a PR is never automatic here — it
> happens only when you (or the human) explicitly ask for it, in this
> session or a later one:
>
> ```bash
> glafka epistle <id>
> ```
>
> See epistle.md. Until that's asked for, the ticket just sits here,
> implemented and reviewed, with nothing more to do — and nothing lost
> by waiting, since closing (`lysis`) refuses on an open PR and this
> ticket has none.
