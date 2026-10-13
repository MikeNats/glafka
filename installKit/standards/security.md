# Lane 1 — Security (BLOCKING)

Grouped the way OWASP groups risk. Each row is a check and the failure it
prevents. Nothing here names a language, framework or vendor — translate it to
whatever this project uses.

## Access control

| Check                                                     | The failure it prevents                                    |
| --------------------------------------------------------- | ---------------------------------------------------------- |
| A route reaching data with no authorisation check         | anyone reads anything                                      |
| **Signed-in checked where owns-this is needed**           | any user reads any other user's data                       |
| **An id from the client used without an ownership check** | insecure direct object reference                           |
| A query missing its tenant or owner scope                 | cross-tenant read, even with a database policy as backstop |
| "Forbidden" where the spec requires "not found"           | confirms a resource exists to someone who should not know  |

## Session and credentials

| Check                                                  | The failure it prevents                     |
| ------------------------------------------------------ | ------------------------------------------- |
| A session not rotated on sign-in                       | session fixation                            |
| Sessions not revoked on sign-out or credential change  | a stolen session outlives the fix           |
| A secret compared with an ordinary equality test       | timing attack — use a constant-time compare |
| A response that differs for known and unknown accounts | account enumeration                         |

## Mass assignment

| Check                                                                        | The failure it prevents                               |
| ---------------------------------------------------------------------------- | ----------------------------------------------------- |
| **A schema accepting an owner id, role, status or quota from a client body** | privilege escalation by adding one field to a request |
| Spreading a request body into an insert or update                            | the same, harder to spot                              |

Server-controlled fields are set **server-side**, never parsed from input.

## Cross-site request forgery

| Check                                                          |                                                         |
| -------------------------------------------------------------- | ------------------------------------------------------- |
| **A state-changing route with no origin check**                | cookie auth means a cross-site form can act as the user |
| A mutation exposed over a method treated as safe and cacheable |                                                         |

A same-site cookie attribute is the first line, not the only one.

## Untrusted input and output

| Check                                               | The failure it prevents                                            |
| --------------------------------------------------- | ------------------------------------------------------------------ |
| A query, command, path or template built from input | injection — bound parameters and argument lists only               |
| Data access spread across the codebase              | one place must be auditable for owner scoping                      |
| Unsanitised markup from import or rich text         | stored cross-site scripting; sanitise **on ingest**, not on render |
| The server fetching a user-supplied address         | server-side request forgery into the private network               |
| A user-supplied address embedded in a page or frame | extract the identifier and **rebuild** the address                 |
| An upload in a format that can carry script         | it is a script container — convert, never serve back as-is         |
| A path or archive entry taken from input            | traversal, and archive entries escaping their folder               |

## Resource exhaustion

| Check                                                | The failure it prevents                |
| ---------------------------------------------------- | -------------------------------------- |
| A write with no quota                                | one account exhausts storage           |
| An entry point with no rate limit                    | denial of service, credential stuffing |
| Unbounded input — body size, page size, array length | memory exhaustion from one request     |
| Work whose cost grows faster than its input          | one small request burns the server     |
| An unbounded retry or an unbounded queue             | a failure amplifies itself             |

## Secrets, logs and supply chain

| Check                                                                |                                                          |
| -------------------------------------------------------------------- | -------------------------------------------------------- |
| A secret, key or connection string in source                         |                                                          |
| A token, session id, credential or personal identifier in a log line |                                                          |
| A new dependency added with no reason given                          | supply chain surface, added silently                     |
| A known advisory in a dependency this diff adds or bumps             |                                                          |
| A new outbound third-party request                                   | data leaves the system; usually a decision, not a detail |

`SECURITY: PASS` or `SECURITY: FAIL`
