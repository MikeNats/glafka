# Lane 5 — Design, principles and reuse (ADVISORY)

**Does this already exist?** The first question, every time. A second way to do
something this codebase already does one way is a finding.

| Check                                                              |
| ------------------------------------------------------------------ |
| A new file in the wrong area for what it does                      |
| A folder gaining a second public entry point instead of one        |
| An entry-point handler holding logic that belongs in a module      |
| A hard-coded literal where a named constant or enum belongs        |
| A user-facing string outside its catalogue                         |
| A name that needs a paragraph to explain — plain words, not jargon |
| A comment over two lines, or one restating the code                |
| A vendor library reached for outside its adapter                   |

## SOLID, as it actually applies

SOLID is object-oriented. Applied literally to code that is not, it becomes
cargo cult — so each letter is written as the concrete rule it maps to.

| Letter                        | The rule                                                                                                 |
| ----------------------------- | -------------------------------------------------------------------------------------------------------- |
| **S** — single responsibility | a module has one reason to change                                                                        |
| **O** — open/closed           | extend by adding a case or an adapter, not by editing the same switch in five files                      |
| **L** — substitutability      | **every adapter for a port passes the same conformance suite** — that suite _is_ Liskov, made executable |
| **I** — interface segregation | a port exposes what the application needs, never everything the vendor can do                            |
| **D** — dependency inversion  | core logic depends on interfaces it owns, never on a vendor library                                      |

## Ports and adapters

The core of the system talks to the outside through interfaces it defines
itself. Each external thing — database, queue, mail, payments, a rendering
library — is reached through an adapter behind one of those interfaces.

| Check                                                    |
| -------------------------------------------------------- |
| Core logic importing a vendor library directly           |
| A vendor type appearing in a signature the core owns     |
| An adapter leaking its vendor's error type to the caller |
| Two adapters for one port that do not share a test suite |

## Other principles worth naming

| Principle                          | The check                                                                  |
| ---------------------------------- | -------------------------------------------------------------------------- |
| **YAGNI**                          | is this built for a requirement that exists today?                         |
| **DRY, honestly**                  | duplicated **knowledge**, not duplicated **text** — see below              |
| **Fail fast**                      | bad configuration stops the process at start-up, not on one rare path      |
| **Illegal states unrepresentable** | a type that permits a state the code then guards against is the wrong type |
| **Composition over inheritance**   |                                                                            |
| **Least astonishment**             | a function that does what its name says, and nothing more                  |
| **Least privilege**                | the narrowest scope, the shortest lifetime, the smallest surface           |
| **Don't reach through**            | talk to a module's entry point, not its internals                          |

**On DRY.** Remove duplicated **knowledge**, not duplicated **text**. Two blocks
that look alike but change for different reasons should stay apart; merging them
creates a shared thing neither owner can safely edit. **Three** occurrences is
when to extract — two is usually coincidence.

**On abstraction.** An interface with one implementation is not an abstraction,
it is indirection. A port with two real adapters earns its keep; one with a
single adapter and a "we might swap it later" is speculative generality.

## Named patterns

Use the standard name when the shape matches. Do not invent a new word for a
known thing, and do not reach for a pattern before the problem is there.

| Group           | Patterns                                                                                                                    |
| --------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Creational**  | factory · builder · prototype · singleton (rarely — it is global state)                                                     |
| **Structural**  | **adapter** · facade · decorator · proxy · composite · bridge · flyweight                                                   |
| **Behavioural** | strategy · observer · command · state · template method · iterator · mediator · chain of responsibility · visitor · memento |

**Adapter** is the one this document leans on: it is what keeps the core free of
vendors. **Strategy** and **state** are the usual honest answers to a switch
that keeps growing.

A pattern applied where the problem does not exist is itself a finding.

`DESIGN: PASS` or `DESIGN: WARN`
