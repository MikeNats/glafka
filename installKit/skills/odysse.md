# glafka: odysse

_Commands here are written as `glafka <command>`. If the bare word does not
run, see `docs/glafka/skills/reference/invoking.md` for the fallback._

Build or refresh the codebase's hierarchical architecture map.

Ὀδύσσεια — a journey through the whole codebase. Run this once to
bootstrap, or occasionally when the docs feel stale. You don't need to
run this per ticket — `epistle` already keeps things fresh incrementally,
scoped to whatever each ticket touched.

## 1. Get the prompt

```bash
glafka odysse
```

Its stdout **is** the brief — the full file tree, plus instructions for
what to write and where. Nothing here is agent-specific; the prompt
carries the whole task.

**The CLI is the only way in.** Never read, import or call anything under
`.glafka/` — that is glafka's own vendored code, there so the commands run,
not for you to use. Its functions write the files a person is supposed to
approve first.

**If a glafka command fails, stop and report it.** Do not find another way
to get the same result. A broken command costs one line at the end; routing
around it writes rules nobody approved and nobody hears about it.

## 2. Do the work

This takes a while — twenty minutes and up on a real repo. **One checklist is
the entire terminal for that whole time.** Write the plan out as five to ten
items before reading anything, then tick them off in whatever task list your
harness redraws in place.

```
[x] map packages/client
[x] map packages/server
[ ] map ml-service, postgres, shared, tooling
[ ] write isolation.json
[ ] top-level README
```

If your harness has no list that redraws in place, **print nothing at all**
until the end. A checklist that is printed rather than redrawn becomes fifteen
copies of itself, which is worse than silence.

For each meaningful directory: read the files in it, write what it does
in plain terms, note key exports and the business logic (why it exists,
not just what the code says), and link to child directory docs.

Save one doc per meaningful directory under `docs/glafka/architecture/`,
mirroring the real directory structure, with a top-level `README.md`
that indexes every major area.

Also: figure out how this project actually runs, in isolation, per
worktree — real ports, real database mechanism, from real files, not
guesses. Write `docs/glafka/architecture/isolation.json` if this project
has something worth isolating (a dev server and/or a database). The
prompt itself explains the schema in full when you run it; only write
this file if there's genuinely something to isolate.

Also: while reading the code, notice the conventions this project already
follows — the things a new contributor would get wrong on day one because
nobody wrote them down. Those go under the `## Proposed` heading of each
`docs/glafka/ethos/ETHOS_*.md` file. The prompt lists this project's own
categories when you run it.

## 3. Ask which conventions to keep

Nothing observed is in force until a human says so — `## Proposed` is
never injected into any prompt. After the scan, glafka lists what was
observed:

```
--- 3 convention(s) observed, awaiting your decision ---
  1. [ETHOS_DOMAIN] (odysse) invoices are immutable once issued
  2. [ETHOS_DOMAIN] (odysse) refunds create a new ledger entry
  3. [ETHOS_CODE] (odysse) errors are wrapped at the boundary
```

Some will be real conventions, some will be coincidences the scan over-read.
A person decides which.

**Never hand them a command to run.** That list and those index numbers are
for you, not for them. Ask them, using whatever mechanism your harness has
for offering options and taking a choice, then run the command yourself.

This is the rule for **every** decision odysse has — conventions, workspace
settings, and any gate added later. A new decision point that ships as "here
is a list, now type indexes" is a regression.

How to ask, at 23 findings:

1. **One question first, for the whole set** — keep all, drop all, or go
   through them. Most runs end here.
2. **Then one question per category**, listing that category's rules, so
   related ones are judged together. Take several answers per question.
3. **A category with more than a handful** — split it across questions
   rather than truncating it. Never drop a finding just to fit.
4. **Map their answers back to index numbers yourself** and call
   `glafka odysse --keep <indexes>`. They never see a number.

If your harness has no way to offer options, that is the one case where you
show the numbered list and the commands below, because the alternative is no
decision at all.

```bash
glafka odysse --keep all    # keep all
glafka odysse --keep 1,3    # keep only those
glafka odysse --keep none   # keep none
```

`--keep` decides and stops — it does not re-scan. Kept ones move into
`## Learned` and are in force from then on. `## Proposed` is cleared either
way, so nobody is asked twice.

**A wrong pick is fixable.** The ones not kept move to `## Dropped` in the
same file. Nothing under that heading is ever sent to an agent, and nothing
re-proposes it on a later scan — but it is still there to read, so a wrong
pick means moving one line back up by hand, not losing a rule.
`--workspace-keep` does the same: the proposal is parked at
`workspace.decided.json` rather than deleted.

This is why ticket one already has conventions to follow instead of an
empty ethos that only fills up after a dozen closes.

Separately, `glafka odysse --compact` proposes merges and retires for rules
already in force. `--audit` is its old spelling — `glafka audit <ticket-id>`
is a different command entirely, the run-cost record.

## 4. Offer the findings — last

Reading a whole codebase turns things up: bugs, dead code, a security hole.
**None of it is a reason to stop the scan.** Write each one in the doc for
the directory it lives in, and keep reading. Severity changes nothing —
serious findings wait like the rest.

Once the conventions and the workspace settings are settled, and only then,
ask one question:

> I noted 2 things while reading — auth in `packages/server`, and a dead
> migration path. Both are written up in their docs. Want to go through
> them now?

If they say no, the findings are in the docs and you are done. Do not offer
to fix anything either way — odysse maps a codebase, it does not change one.
What you found is a ticket for later, and saying so is enough.

## 5. Stop

This is a one-time (or occasional) full pass — not part of any ticket's
normal flow.

**Do not write a report.** glafka already prints one when the scan stops —
the doc count, whether `isolation.json` landed, everything awaiting a
decision, and the next command. It reads all of that back off disk, so it
is right whether or not you say anything.

The files are the deliverable. Never restate a doc's contents in the
terminal, never relay a subagent's report, and never narrate progress in
prose. The only thing worth printing is something that is in no file and
changes what the human does next — five lines at most, and nothing at all
if there is no such thing.
