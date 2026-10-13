# glafka: prosopon

_Commands here are written as `glafka <command>`. If the bare word does not
run, see `docs/glafka/skills/reference/invoking.md` for the fallback._

Turn a persona on or off.

πρόσωπον — the mask an actor wore. A persona does not change what glafka
does. It changes how the answers you read are written.

## What it shapes

Personas apply to text a **person** reads:

- the genesis and heureka skills, while they brainstorm with you
- the coder's final report
- the reviewer's findings

They never apply to code, comments, commit messages, test names, or
identifiers. Those follow this project's own conventions, whatever the
persona says.

## The commands

```bash
glafka prosopon             # what is on, and what you can pick
glafka prosopon dyslexic    # turn it on
glafka prosopon dyslexic    # name it again to turn it off
glafka prosopon --clear     # turn everything off
```

## One at a time

Picking a persona **replaces** whichever one was on.

That is deliberate. Each persona carries its own reply shape — `creative`
asks for two or three directions before picking one, `dyslexic` asks for
one answer and then a stop. Two of those in the same prompt compete, and
nothing decides the winner.

## The ones that ship

| Name       | What it does                                                  |
| ---------- | ------------------------------------------------------------- |
| `creative` | options before the pick, and questions the assumed constraint |
| `teacher`  | asks one guiding question first, then explains the mechanism  |
| `dyslexic` | short chunks, plain English, one step per reply               |

## Your own

Drop `<name>.md` into `docs/glafka/personas/`.

That folder is git-tracked, so your team gets it. A name there overrides
a shipped persona of the same name.

Write it as instructions, and end it with a literal template block the
agent copies — a described shape drifts, a copied one holds.

## What a persona may not do

Sections come from glafka's own instructions. Wording comes from the
persona. A persona never adds, drops, or reorders a section of a report,
a plan, or a review.

So a shorter style can never cost a reader the file, the line, or the
reason a finding matters.
