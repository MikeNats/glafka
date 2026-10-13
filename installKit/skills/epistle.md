# glafka: epistle

_Commands here are written as `glafka <command>`. If the bare word does not
run, see `docs/glafka/skills/reference/invoking.md` for the fallback._

Rebase, push a ticket's branch, and open a PR.

ἐπιστολή — a letter. Where the branch stops being yours alone and
becomes something addressed to a reviewer. **Nothing in glafka's own
flow reaches here automatically** — not `genesis`'s, not `ergon`'s.
Raising a PR only ever happens when you (or the human) explicitly ask
for it, in the same session that finished review or a much later one.

## Before running this

**If the last `ergon` run ended badly** (crashed, timed out, or failed its
own checks): epistle refuses, and names which one happened. Fix that first
— same hard block as ergon's review step.

**If a background `ergon` run is still going**: epistle refuses.
Rebasing onto a live agent's own commits can produce a broken branch.
Check `ergon <ticket-id> --status` first (see ergon.md's "Running
unattended" section).

**If the code hasn't been reviewed since it last changed**: epistle
refuses. "Reviewed" means _since the last change_ — a review followed by
three more `ergon` runs counts as unreviewed, not reviewed. Either:

```bash
glafka ergon <ticket-id> --review        # review it first
glafka epistle <ticket-id> --unreviewed  # or push anyway
```

`--unreviewed` is a deliberate bypass for a genuinely trivial change, not
a silent one — it's recorded permanently in the ticket's stage log, so
the PR's history shows review was skipped on purpose.

**If the checks never ran**: epistle refuses. This is the one every
project's FIRST ticket hits, because `checksCmd` cannot be configured
before a ticket exists. Three steps, in order:

```bash
glafka odysse --checks          # 1. find the real command, once per project
glafka checks <ticket-id>       # 2. RUN it for this ticket, and record it
glafka epistle <ticket-id>      # 3. push
```

**Step 2 is the one that lifts the gate.** Step 1 only proposes a
`checksCmd`; `glafka odysse --workspace-keep` saves it in `isolation.json`
as `workspace.checksCmd`. Neither runs anything for this ticket, and
neither does `krisis`. Re-running `epistle` straight after step 1 gives
the same refusal, which reads like a loop with no exit.

`glafka checks` costs nothing — no model call, and it does not use up one
of the ticket's review rounds. If it comes back failing, the failures are
real and the push should stay blocked.

`--unreviewed` is the only override. It walks past these gates at once: no
review since the last code change, no verdict, a verdict that was only
parsed out of the reviewer's text, and checks that never ran. It never
walks past checks that ran and FAILED — those always block. It exists
for a project that genuinely has nothing to run. Every gate it walks past
is named on the ticket, in the push output, and at the top of the PR body,
so do not reach for it to escape a misconfiguration.

(`--unverified` used to be a second override covering only the checks
gate. It is gone — two flags for one idea let a person open the checks
gate while still believing the review gate had held.)

## Running it

```bash
glafka epistle <ticket-id>
```

In order:

1. Rebases the worktree onto the latest `origin/<base>` — so the PR
   lands on current code, not wherever the ticket branched off. A
   conflict throws git's own error and stops here; that needs you, not
   something to paper over.
2. Refuses if `.env.glafka` is tracked in the diff — it can hold a real
   database URL (see the isolation profile,
   `docs/glafka/architecture/isolation.json`), and this is
   the last-resort net before it would otherwise leak into a public PR.
3. **Tidies the docs, and commits them onto the branch** — see below.
4. Pushes the branch and opens the PR.

stdout prints `<ticket-id>  pushed  ·  PR opened: <prUrl>` — or
`PR updated: <prUrl>` when the branch already had a PR. Capture that URL.

## The tidy-up, step 3

Two prompts run **before** the push, in the ticket's own worktree, and
whatever they write is committed onto the branch as one
`docs: sync plan and architecture for <id>` commit. So the doc update
travels **inside the pull request**, where a reviewer sees it.

**If this ticket has a plan doc**: a prompt comparing the plan against
what was actually built. Update `docs/glafka/tickets/<id>/plan.md` if
anything diverged (a step skipped, an approach that changed
mid-implementation), and say so under a `## Result` heading. If the plan
matches exactly, say so and change nothing.

**Always**: a prompt updating `docs/glafka/architecture/` for whatever
this ticket touched, scoped to the ticket's own diff — not a full
`odysse` rescan.

Two rules make this safe to run unattended:

- **Only `docs/glafka/` is committed.** Anything written outside it is
  left exactly where it was — a doc commit can never smuggle in code.
- **Nothing changed means no commit.** Docs that already told the truth
  produce no empty commit, and epistle says so:
  `docs already matched this branch — nothing to commit`.

Neither prompt needs an approval from the human — this is doc upkeep on
already-approved, already-reviewed work, not new work.

That prompt does **not** record ethos, and neither does anything else
from here on. Rules are only captured at the stages a human is actually
present for — `heureka` and `genesis` — because the capture block asks
for what the human said, and nobody is watching an unattended doc sync.
`lysis` surfaces whatever is still pending; it adds nothing new.

**Why before the push, not after.** It used to run after the PR was
open, against the main checkout — so its edits landed on the base
branch, uncommitted, belonging to no ticket. Nobody ever committed them,
and the architecture map went stale one ticket at a time.

`--no-tidy` skips the whole step. It is for a push that must go out now;
the plan and the map are then left not matching the branch, and epistle
says so on stdout.

## No Superpowers skill runs here

Nothing in Superpowers' 14 fits push mechanics or doc bookkeeping. In
particular, **don't invoke `finishing-a-development-branch`** here — its
push/PR-or-discard decision and worktree teardown are exactly what
`epistle` and `lysis` already do, with more ticket state than that skill
has any way to see. The "verify tests" part of it is `ergon --review`'s
job, not this command's — epistle only checks that a review ran
_recently_, a check `--unreviewed` deliberately bypasses; it never runs
the suite itself.

## After it

**Every file path you put in front of a person is a link.** Write it as a
clickable relative markdown link — `[docs/glafka/tickets/2026-08-07-add-dark-mode-to-settings/plan.md](docs/glafka/tickets/2026-08-07-add-dark-mode-to-settings/plan.md)`,
never a bare path. Keep trailing punctuation outside the link, or the
period gets swallowed into the URL and the link breaks.

**Never hand the person a CLI command here. Hand them the skill.** What a
person types next is the lysis skill, in your platform's own form:
`/glafka:lysis` (Claude Code, Gemini CLI), `/glafka-lysis` (Cursor,
OpenCode), `/skill:glafka-lysis` (Kimi), or the `glafka-lysis` skill
(GitHub Copilot). Not `glafka lysis`, and never
`node .glafka/bin/glafka.js lysis`. The skill carries the ticket-state
checks, the refusal reasons and the persona; a raw command carries none of
it, and the long form additionally breaks from any folder but the
repository root. This rule covers the report below and every follow-up you
name after it.

> Ticket `<id>`: pushed.
>
> PR <opened or updated>: `<prUrl>`
>
> Report this and stop — the PR needs a human review on GitHub now,
> which isn't something this session can wait on. Once it's merged (or
> you want to abandon it), run `<lysis skill> <ticket-id>`
> to close the ticket and free its worktree and port. The branch is
> kept. See lysis.md —
> it checks the PR's real state on GitHub and refuses while it's still
> open.

The only commands that stay in CLI form anywhere in this document are the
ones **you** run to clear a gate, in "Before running this" — they carry
flags (`--review`, `--unreviewed`, `--checks`) that no slash command
accepts, and `glafka checks` has no skill at all.
