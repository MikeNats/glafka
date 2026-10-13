# glafka: superpowers skills — how to invoke them

Every glafka flow that names a [Superpowers](https://github.com/obra/superpowers)
skill means **run that skill's real file**. This page is the one place that
says what "invoke" costs you, so the flow docs don't each repeat it and drift.

Read it once per session, the first time a flow sends you here.

## The rule

**Do not write your own version of a skill from memory.** Superpowers'
own bootstrap (`using-superpowers`) puts it plainly:

> "I remember this skill" → Skills evolve. Read current version.

A skill you half-remember is not the skill. Load the file, then follow it.

## The four steps, every time

1. **Load it.** Invoke the skill by name — see the naming table below.
2. **Announce it.** Say `Using <skill> to <purpose>` before you act.
3. **Follow it exactly.** Not the gist of it. The steps as written.
4. **Checklist → todos.** If the skill has a checklist, create one todo per
   item. A checklist you kept in your head is a checklist you skipped.

## Naming

Superpowers keeps one shared copy of each skill and every harness reads the
same file. Only the way you address it changes:

| Harness                                 | How to name it       |
| --------------------------------------- | -------------------- |
| Claude Code, Cursor, Kimi Code, Copilot | `superpowers:<name>` |
| Gemini CLI, OpenCode                    | `<name>`             |

Those six are the platforms `glafka install` supports. Superpowers itself
runs on more; if you are on one of those, use the bare name.

If the prefixed form doesn't resolve, retry bare. If neither resolves,
Superpowers is not installed here — take the flow's agnostic path instead
(each flow doc has one) and say so out loud. Don't improvise the skill.

## Templates in glafka's flow docs are output shapes, not replacements

`genesis.md` and the others print a document shape — the plan layout, the
design reply layout. Those say what the **output** must look like when it
lands in a glafka ticket. They do not say what to do instead of the skill.

Order is fixed:

```
run the skill  →  it produces its content  →  shape that content to glafka's layout
```

Never the reverse. Writing to the layout first and skipping the skill loses
what the skill actually adds — `writing-plans`' no-placeholder scan, its
self-review pass, its type-consistency check.

## Why glafka has to say all this

Superpowers' own bootstrap ranks instructions like this:

> User instructions (CLAUDE.md, AGENTS.md, direct requests) take precedence
> over skills.

glafka's flow docs **are** user instructions. So they outrank the skills by
default, and any skill step glafka words loosely gets dropped without anyone
noticing. That is why every glafka reference to a skill is written as a
requirement, and why this page exists.

## Where each skill is used

| Skill                            | Flow             | Step                                              |
| -------------------------------- | ---------------- | ------------------------------------------------- |
| `brainstorming`                  | genesis, heureka | turning a raw idea into a spec                    |
| `writing-plans`                  | genesis          | turning a spec into a task plan                   |
| `subagent-driven-development`    | ergon, genesis   | implementing the plan                             |
| `executing-plans`                | ergon, genesis   | same, when subagents aren't available             |
| `test-driven-development`        | ergon            | bundled inside the two above                      |
| `verification-before-completion` | ergon            | bundled inside the two above                      |
| `systematic-debugging`           | ergon            | a check fails and the cause isn't obvious         |
| `requesting-code-review`         | ergon            | only when this project has no reviewer configured |
| `receiving-code-review`          | ergon            | judging the findings that return                  |

`heureka` has no fixed plan, so `writing-plans` never applies there.
Where a row says "only when" or "a check fails", the skill is conditional
— and required as soon as that condition holds.

## Skills glafka deliberately does not use

These are not oversights. Invoking them breaks something glafka already did:

| Skill                            | Why not                                                             |
| -------------------------------- | ------------------------------------------------------------------- |
| `using-git-worktrees`            | `plan` already made this ticket's worktree, ports and database      |
| `finishing-a-development-branch` | its push/PR decision is `epistle`'s, and pushing is never automatic |

## Not installed?

`glafka install` printed the install command for whichever platforms you set
up. Superpowers is optional — glafka runs without it — but every flow is
weaker without it, and the flow doc will tell you which fallback to use.
