# glafka: heureka

_Commands here are written as `glafka <command>`. If the bare word does not
run, see `docs/glafka/skills/reference/invoking.md` for the fallback._

Explore a rough idea in real code — no spec or plan required.

εὕρηκα — "I've found it!" `genesis` is for when structure is worth the
overhead; this is for finding out whether it is.

## Superpowers skills used here

| #   | Skill                         | Why                                                                    |
| --- | ----------------------------- | ---------------------------------------------------------------------- |
| 1   | `brainstorming` (conditional) | required the moment the rough idea needs sharpening before you dive in |

Nothing else from Superpowers fits — there's deliberately no fixed plan
here for `writing-plans`/`subagent-driven-development` to work from.

**Conditional is not optional.** If you reach for `brainstorming` at all,
read `docs/glafka/skills/reference/superpowers.md` and run the real file — announce
it, follow it exactly, turn its checklist into todos. The one thing this
flow overrides is its ending: don't let it produce a formal spec, because
heureka has no spec step.

## 1. Open the ticket

```bash
glafka heureka "<rough idea>"
```

Its stdout **is** the exploration brief — the idea, plus this project's
codebase map, conventions, and project memory, and an explicit "no fixed
plan to follow." Capture the printed ticket id from stderr.

## 2. Explore

This is deliberately not `subagent-driven-development`'s strict
TDD-per-step loop — that's for an approved plan, not an open idea. Read
the real code, try approaches, change direction if the first one doesn't
pan out. If the idea itself needs sharpening first, invoke
`superpowers:brainstorming` (bare `brainstorming` on harnesses without the
prefix) — but don't force a formal spec out of it.

Still write real code: whatever you land on should run and be testable,
not just sketched.

**Record what gets decided, the moment it is said.** Exploring is where
directions are abandoned, and the reason one lost is the part nobody
writes down:

```bash
glafka apofasi <id> "<what was decided>"
```

A rule that outlives this ticket is `glafka psyche <id> --<category>
"<what they said>"` instead — same "as you go, not batched" rule.

**When you put a direction back to them, use `genesis`'s design shape** —
step 2 of `genesis.md` has it. Code first, one numbered item per change,
"why X, not Y" naming what you rejected, then out of scope and one
closing question.

Two differences here, because exploring is looser than a spec:

- The numbered items are whatever you actually tried, not a proposal —
  say plainly which ones you abandoned and why.
- "Out of scope" may be "unknown yet". That is a real answer while
  exploring; leaving the heading out is not.

## 3. If the idea turns out to need real structure

Stop and say so — a multi-step plan with sign-off is what `genesis` is
for, not this one.

## 4. When you're done exploring

**Every file path you put in front of a person is a link.** Write it as a
clickable relative markdown link — `[docs/glafka/tickets/2026-08-07-add-dark-mode-to-settings/plan.md](docs/glafka/tickets/2026-08-07-add-dark-mode-to-settings/plan.md)`,
never a bare path. Keep trailing punctuation outside the link, or the
period gets swallowed into the URL and the link breaks.

Report the ticket id, what (if anything) is worth reviewing, and that
next is `glafka ergon <id> --review` to review (see
ergon.md — same final-review step any other ticket gets, even though
this one skipped ergon's implementation half). Then, whenever it's
actually asked for: `glafka epistle <id>` to push, or
`glafka lysis <id>` to close directly (see lysis.md
— closing is irreversible, and it refuses while a PR from this ticket is
still open).
