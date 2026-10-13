# glafka: how to invoke the CLI

Every flow doc writes commands as `glafka <command>`. This page is the one
place that says what to do when that does not run, so the flow docs don't
each repeat it and drift.

Read it once per session, the first time a command fails to start.

## The short version

```bash
glafka poreia --all
```

If that works, nothing on this page matters. Use it everywhere.

## When the bare word does not resolve

`glafka install` vendors a complete copy into `.glafka/`, so there is always
a second way in:

```bash
node .glafka/bin/glafka.js poreia --all
```

Two things to know about this form, because both have cost real time:

- **It is resolved by Node, relative to the current folder.** Run it from
  anywhere but the repository root and you get `MODULE_NOT_FOUND` and a
  Node stack trace — not a glafka error. glafka cannot catch that: the
  failure happens in the module loader, before any of its code runs.
- **`cd` to the repository root first**, then run it. From inside a ticket
  worktree, use the worktree's own root the same way.

## Which one an agent is told to use

An agent does not choose. `glafkaCli()` in `src/util/cli.ts` picks one when
the prompt is built, and the ordering is deliberate:

| Condition                           | What the prompt says           |
| ----------------------------------- | ------------------------------ |
| a real, executable `glafka` on PATH | `glafka <command>`             |
| no usable `glafka` on PATH          | `node .glafka/bin/glafka.js …` |

The bare word is preferred **when it really resolves**, because an agent's
permission allowlist is written by hand and prefix-matched: `Bash(glafka:*)`
is the rule a person writes, and it does not match a long absolute path.
Handing out the path form unconditionally traded one silent failure for
another.

Both forms are allowed in the shipped slash commands for that reason — see
the `allowed-tools` block in any `.claude/commands/glafka/*.md`.

## Why the docs stopped writing the long form

The flow docs used to spell out `node .glafka/bin/glafka.js` on every line.
That taught the cwd-fragile form as the normal one, in repositories where
the bare word worked fine — so a command copied out of a doc and run from
the wrong folder failed with a Node stack trace and no explanation.

The docs now write what a person should type. This page is where the
fallback lives.
