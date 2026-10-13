# glafka: cancel

_Commands here are written as `glafka <command>`. If the bare word does not
run, see `docs/glafka/skills/reference/invoking.md` for the fallback._

Abandon a ticket, at any point before `epistle` has pushed it.

The only cleanup path for a ticket still in `brainstorming` or
`spec-written` — those have no worktree or branch yet, so `lysis --sweep`'s
orphan scan can never see them (it only finds disk artifacts with no
matching ticket, never the other way around). Cancelling is what makes
an abandoned idea actually go away instead of sitting there forever.

## Running it

```bash
glafka cancel <ticket-id>
```

If the ticket already has real resources (`plan` or `genesis` already
ran), this tears down the worktree exactly like `lysis` does, and frees its
port. The branch is kept.
If it's still at `brainstorming`/`spec-written` — no worktree, no branch yet —
there's nothing to tear down; it just records the cancellation and
archives the ticket.

If the worktree has uncommitted changes, cancel refuses and lists them.
`glafka cancel <ticket-id> --force` cancels anyway and throws those
changes away.

Refuses the same way `lysis` does if the ticket is already closed, or if
a background `ergon` run is still going (check `ergon <ticket-id>
--status` first).

## Ethos candidates — discarded, not decided

Unlike `lysis`, cancel does **not** ask you to rule on pending
candidates. Cancelling means the whole ticket is being thrown away —
there is no point asking a human to individually approve proposed rules
about code that is about to vanish. They're just discarded.

## When to use this instead of `lysis`

`lysis` is for a ticket whose work is done, one way or another — merged,
or genuinely finished with. `cancel` is for a ticket that never got that
far: an idea you decided not to pursue, mid-brainstorm or mid-plan,
before it ever cost you a worktree or a port.
