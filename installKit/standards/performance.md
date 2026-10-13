# Lane 4 — Performance and data access

Advisory, except the hard rule below and anything this project has marked
blocking.

## The one hard rule — N+1

**N+1 is not a judgement call.** The rule is:

> A request's query count must not depend on how many rows it returns.

Assert the count in a test. If it moves when the dataset grows, it is N+1.

Common shapes: a query inside a loop · a query inside a map over rows · a query
inside a parallel await over rows · a relation loaded per item instead of in one
pass · a permission checked per row.

This one is written as something a test can assert precisely so it stops being
an argument.

## Queries

| Check                                                      |          |
| ---------------------------------------------------------- | -------- |
| Selecting every column where the needed ones are known     | advisory |
| No default limit on a list endpoint                        | advisory |
| Offset paging on a table expected to grow — keyset instead | advisory |
| Filtering or sorting on a column with no index             | advisory |
| A full scan on a growing table                             | advisory |
| Work that could be one round trip done as several          | advisory |
| A transaction held open across a network call              | advisory |
| A write path with no batching where volume is expected     | advisory |

## APIs and responses

| Check                                                            |          |
| ---------------------------------------------------------------- | -------- |
| Response time that depends on dataset size rather than page size | advisory |
| An immutable resource served without a long cache header         | advisory |
| Fields in the payload the client never reads                     | advisory |
| Blocking or synchronous work on a request path                   | advisory |
| Work beyond the platform's request timeout that is not a job     | advisory |
| A retry with no backoff and no cap                               | advisory |
| A mutation that is not safe to repeat, with no idempotency key   | advisory |

## Client and rendering

_(skip and say so where there is no user interface)_

| Check                                                       |          |
| ----------------------------------------------------------- | -------- |
| Bundle growth beyond this project's budget                  | advisory |
| Work added to a render loop or a per-frame path             | advisory |
| A layout that shifts after load                             | advisory |
| An interaction that blocks the main thread                  | advisory |
| An asset served unsized, uncompressed, or in a heavy format | advisory |

`PERFORMANCE: PASS` / `WARN` (or `FAIL` on a blocking item)
