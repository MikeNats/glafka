# How to review

Five lanes. Security, Correctness and Tests **block**. Performance and Design
are advisory unless this project marks an item blocking.

| Rule                                           | Why                                                   |
| ---------------------------------------------- | ----------------------------------------------------- |
| **Review the diff, not the repo**              | pre-existing problems belong in their own ticket      |
| **Only report findings you are ~80%+ sure of** | a noisy review gets ignored, which is worse than none |
| **Every finding needs a failure**, not a smell | "input X → wrong result Y", or it is not a finding    |
| **Point at `file:line` and say the fix**       | "consider refactoring" is not actionable              |
| **Order by severity**, worst first             |                                                       |
| **Review the code, never the author**          |                                                       |

If the diff is too large to hold in your head, say so and review it in parts. A
review that skimmed is worse than one that stopped.

**Solve today's problem.** Do not ask for work against a requirement nobody has
yet. Speculative generality is a finding, not a virtue.

## Do not report — the build already catches these

<!-- List what this project's lint, formatter, type checker and audit already
     enforce. A reviewer repeating a machine wastes the round. -->

- Formatting. The formatter decides, and it is not discussed.
- Anything the type checker rejects.
- Anything the linter rejects.

## Do not reopen — these are settled

<!-- Decisions this project already made AND rejected alternatives for.
     Re-proposing a rejected option is not a finding. Add yours here. -->

If you believe a settled decision is now wrong, raise it separately with new
evidence. Do not block a ticket on it.

## Lanes that do not apply

A library with no browser skips compatibility. A project with no database skips
the query items. Write `LANE: N/A` with one line saying why. Skipping a lane in
silence and skipping it out loud are different answers.

## Output format

```
<file>:<line>  LANE  one sentence: the defect
               failure: concrete input or state → wrong result
               fix:     what to do instead
```

Then the five verdict lines, each on its own:

```
SECURITY:    PASS | FAIL
CORRECTNESS: PASS | FAIL
TESTS:       PASS | FAIL
PERFORMANCE: PASS | WARN | FAIL
DESIGN:      PASS | WARN
```

**If nothing is found, say so plainly and give the verdicts.** An empty review
is a real result. Inventing findings to look thorough is the failure this
document exists to prevent.
