# glafka: lysis

_Commands here are written as `glafka <command>`. If the bare word does not
run, see `docs/glafka/skills/reference/invoking.md` for the fallback._

Close a ticket: tear down its worktree. The branch is kept.

λύσις — dissolve. Every ticket ends here, one way or another — landed
and merged, or abandoned. There's no undo for this: once it runs, the
worktree is gone.

**What lysis removes and what it leaves:**

| Thing                    | After lysis | Why                                                      |
| ------------------------ | ----------- | -------------------------------------------------------- |
| the worktree             | gone        | its whole point                                          |
| containers, databases    | gone        | via this project's `teardownCmd`                         |
| the dev server           | stopped     | before the worktree goes, so it can't hold a port        |
| **the local branch**     | **kept**    | it is the only record of the work if the PR never merged |
| **the branch on GitHub** | **kept**    | glafka never touches a remote here                       |

Keeping the branch is deliberate, not an oversight. Once the PR is merged
you usually want it gone — `glafka lysis --sweep` finds branches no
active ticket claims and asks before deleting each one. The remote branch
is yours to delete (GitHub's "delete branch on merge" does it for you).

## Before running this

**If the ticket has an open PR** (`epistle` already ran): lysis itself
checks the PR's real state on GitHub and
refuses if it's still open — merge or close it there first. There's no
override for this; a PR still open means real, reviewed work would be
destroyed with no way back, so the check doesn't take your word for it.
If `gh` cannot reach GitHub, lysis refuses too. Check the PR yourself,
then run `glafka lysis <ticket-id> --pr-settled`. It skips only that
failed check, and it is recorded on the ticket. A PR that GitHub shows
as open still blocks.

**If a background `ergon` run is still going**: lysis refuses. Check
`ergon <ticket-id> --status` first (or stop it — see ergon.md's "Running
unattended" section) and wait for it to actually finish.

**If the ticket has real, uncommitted work you still want to keep**:
commit it — even to a throwaway branch — before running lysis. Nothing
else saves it once the worktree is gone.

**If anything was recorded after `ergon --review` ruled on the pile**: lysis
refuses to close until you say what to do with it. Usually there is
nothing — see below.

## Running it

```bash
glafka lysis <ticket-id>
```

Runs this project's own isolation teardown if it has one (e.g. removing
a per-ticket database container), force-removes the worktree (the branch
stays — see the table above),
and records the close on the ticket's stage log — which is what makes it
closed. Its ports need no releasing — nothing ever
recorded them as taken; they are free as soon as the dev server stops. This
is the one genuinely irreversible step in the whole lifecycle.

## No Superpowers skill runs here

**Don't invoke `finishing-a-development-branch`** — its push/PR decision
and worktree teardown are what `epistle` and this command already did
together, with far more ticket state than that skill has any way to
see. The verifying itself was `ergon --review`'s job, earlier in the
flow, not epistle's or lysis's.

## Ethos candidates — normally already handled

Proposed rules are ruled on at the end of **`ergon`'s review step**
(`ergon <id> --review --keep ...`), not here. See ergon.md.

lysis is the **top-up**. It only asks about candidates still awaiting a
decision — something recorded after that ruling, or a ticket that was
never reviewed. Most closes involve nothing, and go through in one command.

When there _is_ something pending, lysis lists it and refuses:

```
ticket 2026-08-07-add-dark-mode-to-settings has 1 ethos candidate(s) awaiting a decision — ...
  1. [ETHOS_TESTING] (you said) every endpoint needs a 401 test
```

**A human reads that list, not the agent.** An agent proposing a rule and
then approving its own proposal is not review. Show the list, then let the
human pick:

```bash
glafka lysis <ticket-id> --keep all     # keep all
glafka lysis <ticket-id> --keep 1,3     # keep only those
glafka lysis <ticket-id> --keep none    # discard all
```

A refused close changes nothing — nothing is recorded, so the worktree,
the branch, and the ticket are all exactly as they were. There is no rush
to answer.

Kept rules are appended under `## Learned` in the matching
`docs/glafka/ethos/` file; your own `## Authored` rules are never touched.
Discarded candidates stay listed on the closed ticket, so a rule you turned
down is still readable later.

## `--sweep`: cleaning up everything else left behind

Closing ticket `<id>` only releases what THAT ticket owns. Crashes, a
manual `rm -rf`, or a ticket file deleted by hand can leave other things
behind that no ticket claims any more. `--sweep` finds those and offers
each one for deletion, right after the close:

```bash
glafka lysis <ticket-id> --sweep
```

It asks once per orphan and deletes only what you say yes to:

```
2026-08-07-add-dark-mode-to-settings -> closed
delete .worktrees/2026-08-05-add-dark-mode?  (checkout left on disk) [y/N] y
deleted .worktrees/2026-08-05-add-dark-mode
delete glafka/2026-08-05-add-dark-mode?  (local branch with no ticket) [y/N] y
deleted glafka/2026-08-05-add-dark-mode
delete docs/glafka/ethos/ETHOS_LEGACY.md?  (category gone from categories.json) [y/N] n
kept    docs/glafka/ethos/ETHOS_LEGACY.md
2/3 orphan(s) deleted
```

Anything other than `y` is a no. **This deletes for real** — the worktree
and branch are force-removed, and there is no undo.

### What counts as an orphan

| Kind       | Orphaned when                                     |
| ---------- | ------------------------------------------------- |
| worktree   | a dir under `.worktrees/` no active ticket claims |
| branch     | a `glafka/*` branch no active ticket claims       |
| ethos file | its category is no longer in `categories.json`    |

A **closed** ticket counts as having no claim — closing it already released
its own resources, so anything left under its id is leftover.

Ports are absent from that list on purpose: nothing records a port as taken,
so a crashed ticket cannot leave one behind. A port is free the moment
whatever was listening on it stops.

**Read the ethos-file one before answering.** It holds real rules that
nothing reads any more; the content may be worth moving into a category
that still exists rather than deleting.

### When there's no terminal

An agent running `--sweep` has nobody to answer the questions. In that
case it lists the orphans, **deletes nothing**, and stops:

```
4 orphan(s) found, and no terminal to ask on:
  1. .worktrees/2026-08-05-add-dark-mode — checkout left on disk
  ...
```

Show that list to a human. Once they have decided:

```bash
glafka lysis <ticket-id> --sweep --kill all     # delete all
glafka lysis <ticket-id> --sweep --kill 1,3     # delete only those
glafka lysis <ticket-id> --sweep --kill none    # delete nothing
```

Never guess a `--kill` value on a human's behalf. The questions exist
because the answers are theirs.

### Order

Worktrees are offered before branches, on purpose: git refuses to delete a
branch that is checked out in a worktree, so the worktree has to go first.
Answering no to a worktree and yes to its branch will fail on the branch —
that is git protecting you, not a bug.
