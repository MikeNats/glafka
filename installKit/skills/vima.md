# glafka: vima

_Commands here are written as `glafka <command>`. If the bare word does not
run, see `docs/glafka/skills/reference/invoking.md` for the fallback._

Move a ticket forward by one step.

βῆμα — a pace. You do not tell vima what to do next; it reads where the
ticket already is and takes the one step that follows. Run it again and
it takes the next one.

## When to reach for it

You stepped away, or a session ended, and you want to carry on. There is
no separate "resume" — picking up and carrying on are the same move.

Start by seeing where things stand, which costs nothing:

```bash
glafka poreia --all
```

Then advance the one you care about.

## Running it

```bash
glafka vima <ticket-id>
glafka vima --all                 # every open ticket, one step each
glafka vima <ticket-id> --restart  # just start this ticket's app again
glafka vima --all --restart        # every open ticket's app
```

It prints one line per ticket: the id, the action it took, and why.

## What it decides

vima reads the ticket and picks the step itself:

| It finds                            | It does                                |
| ----------------------------------- | -------------------------------------- |
| no plan yet                         | stops — `plan` is yours to run         |
| a plan and no coder running         | dispatches the coder                   |
| a coder still running               | stops, and says so                     |
| the coder finished, checks green    | dispatches a reviewer                  |
| the same, and the spec has AC       | dispatches a QA tester first           |
| a failed acceptance criterion       | sends it back to the coder             |
| a QA round that ended any other way | stops — it needs you                   |
| a QA round you started again        | closes it when it ends, then goes on   |
| every criterion skipped after that  | dispatches a reviewer                  |
| a blocking review                   | sends it back to the coder             |
| a clean review                      | stops — ready for you to push          |
| the coder raised `aporia`           | stops — it is stuck and wants a person |
| max review rounds reached           | stops — the loop is not converging     |

Closed and cancelled tickets are skipped.

## What it will not do

**It never pushes.** A clean review ends with "ready for you", and
`epistle` stays a thing you run deliberately.

**It never closes.** `lysis` is irreversible, so it is never automatic.

**It never overrides a stop.** When it says "needs you", running it again
changes nothing — the condition has to be dealt with first. After a QA round
stopped, it never starts the next QA round itself: `ergon <id> --review` is
yours to run.

## Reading the output

`spawned-coder`, `spawned-verifier` (the QA tester, checking the acceptance
criteria) and `spawned-reviewer` mean an agent is now running in the
background; the step is under way, not finished. Check on it with:

```bash
glafka ergon <ticket-id> --status
glafka ergon <ticket-id> --review --status
```

`ready` means the work is done and reviewed, waiting on you to push.

`none` with a reason is vima declining to guess. The reason names what it
is waiting for.

`error` is a ticket it could not read. The others still advance — one bad
ticket does not stop the sweep.

## Cost

`vima` itself costs nothing. The agents it dispatches do — a coder run and
a reviewer run are real spend. `--all` on a busy project can start several
at once, so read `poreia --all` first if that matters.

Afterwards, what each run actually cost:

```bash
glafka audit <ticket-id>
```
