# Lane 2 — Correctness and compatibility (BLOCKING)

## Correctness

| Check                                                                        | The failure it prevents                 |
| ---------------------------------------------------------------------------- | --------------------------------------- |
| An unvalidated boundary — body, query, parameter, import, message            | untrusted input reaching the domain     |
| A stored change that edits an already-applied migration                      | two databases silently diverge          |
| A soft-deleted or archived row not excluded by default                       | deleted data reappears                  |
| A bulk operation touching rows outside its stated scope                      | clobbers work it was not asked to touch |
| An error path leaking an internal message or query text                      |                                         |
| A `catch` that swallows without logging or rethrowing                        | a failure that leaves no trace          |
| Time, money or measurement handled without its type, unit, precision or zone | wrong answers that look right           |
| A comparison or sort that assumes one locale or one encoding                 |                                         |
| Concurrent access to shared state with no ordering guarantee                 | lost updates, torn reads                |

## Compatibility

**Compatibility is a correctness failure, not polish** — "works on my machine"
is not working. _(skip this section and say so where there is one runtime only)_

| Check                                                                     |                                      |
| ------------------------------------------------------------------------- | ------------------------------------ |
| A platform API used with no baseline support and no guard                 |                                      |
| Environment-specific globals touched where they do not exist              | breaks server rendering, or a worker |
| Values formatted by hand instead of through the platform's locale support | wrong in other locales               |
| An interaction with no equivalent on another input device                 | keyboard, touch, pointer             |
| A version floor raised without saying so                                  | breaks consumers silently            |

`CORRECTNESS: PASS` or `CORRECTNESS: FAIL`
