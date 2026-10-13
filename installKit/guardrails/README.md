# guardrails

Everything that limits what the coder agent can do. One folder, one file per
technique, one JSON that turns them on and off.

**Default is level 0 — nothing is enforced.** glafka behaves exactly as it did
before until you pick a higher level. Nothing here breaks your current setup.

---

## The one idea

There are only two ways to stop a program.

```
DOORMAN                              WALL
inspects the command and objects     the operating system refuses

runs BESIDE the agent                runs BELOW the agent
can be tricked                       cannot be tricked
cheap, works everywhere              needs docker or macOS sandbox
```

A doorman checks people at the door. It cannot follow them around the building.

So when the agent writes `build.js` and then runs `node build.js`, the doorman
sees an allowed file write and an allowed command. It never sees what `node`
did next. **A new process is a blind spot.**

A wall has no blind spot. Every process, and every child of every process,
must ask the operating system for the disk and the network. The wall sits
there.

Both are in this folder. Doormen are cheap and catch mistakes. Walls are real
and catch attacks. Use doormen at low levels, add the wall at high levels.

---

## Files

| File                       | Kind      | Stops                                                                         | Can it be beaten?                     |
| -------------------------- | --------- | ----------------------------------------------------------------------------- | ------------------------------------- |
| `layers/filesystem.ts`     | doorman   | reads/writes outside the worktree                                             | yes — via a child process             |
| `layers/exec.ts`           | doorman   | commands not on the allow list                                                | yes — via a script file               |
| `layers/execFilesystem.ts` | doorman   | allowed commands (`cp`, `git rm`…) touching paths outside the worktree        | yes — via a command it does not track |
| `layers/network.ts`        | doorman   | known network commands                                                        | yes, easily — see the file            |
| `layers/hostexec.ts`       | spotlight | nothing — it names changed files that run on YOUR machine, at review and push | only if you do not read the list      |
| `layers/shellwords.ts`     | helper    | splits a shell string into commands for `exec`; refuses one it cannot read    | not a layer on its own                |
| `layers/secrets.ts`        | **wall**  | the agent ever seeing a real password                                         | no                                    |
| `layers/sandbox.ts`        | **wall**  | the disk and network themselves                                               | no                                    |

## Which harness enforces this

The doorman files above only decide "allow" or "deny" — something still has to
call `decide()` **before** the agent's tool actually runs, or the decision
never reaches anything. That's a hook, registered in the harness's own
config, and every harness names and shapes it differently:

| Harness       | Config file                | Adapter                    | Notes                                                                                                                                                                                                                                                               |
| ------------- | -------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code   | `.claude/settings.json`    | `hooks/hook.ts`            | exit 2 = block                                                                                                                                                                                                                                                      |
| Gemini CLI    | `.gemini/settings.json`    | `hooks/hook-gemini.ts`     | field names for `write_file`/`replace`/`read_file` are best-effort                                                                                                                                                                                                  |
| Cursor        | `.cursor/hooks.json`       | `hooks/hook-cursor.ts`     | **file edits are not interceptable in Cursor at all** — only shell + reads                                                                                                                                                                                          |
| OpenCode      | `.opencode/plugin/`        | `hooks/opencode-plugin.ts` | in-process plugin, not a subprocess — denies by throwing. Installed as a small plain-JS loader that imports the compiled `opencode-plugin.js` (see `bin/hooks/install.ts`), not a verbatim copy                                                                     |
| Kimi Code CLI | `~/.kimi-code/config.toml` | `hooks/hook-kimi.ts`       | **global, not per-project** — one install affects every repo run through Kimi on this machine. Lower confidence: only Bash is confirmed against real docs.                                                                                                          |
| Copilot CLI   | `.github/hooks/*.json`     | `hooks/hook-copilot.ts`    | `preToolUse`. Fails closed: any non-zero exit denies, exit 2 denies even if our JSON said allow. Sends `toolArgs` as an object OR a JSON string — both are read. Tool names are not fully documented, so unknown ones fall through to the shared unknown-tool path. |

`core.ts` holds the one shared decision loop (repo/policy/scope resolution,
`expandExec`, the decide+audit loop). Each `hook-*.ts` / the OpenCode plugin
only translates its own harness's payload shape into the canonical
`{op, ...}` action vocabulary and formats the answer back in that harness's
own convention — that's the only part that's genuinely harness-specific.

```bash
glafka guardrails --install-hook   # installs into every harness above at once
```

Both walls are verified on this machine, not assumed:

```
glafka guardrails --backends     # what this machine can enforce
glafka guardrails --test <id>    # run probes inside the real cage
```

`--test` reports three outcomes, not two. `????` means the probe could not run,
and that is never printed as a pass — a blocked probe inside a cage that never
started proves nothing.

**One honest compromise, macOS only.** Docker mounts just the worktree, so reads
are allow-listed by construction. The `sandbox-exec` fallback cannot scope reads
without breaking the process (the system paths a program needs in order to start
are not practically enumerable on macOS 26), so there reads are allowed broadly
and then `$HOME` is taken back. Writes stay allow-listed and the network is off
either way — and with no way out, a secret that can be read still cannot leave.
Prefer docker when it is running.

Every doorman file exports the same three things. Learn one, you know all:

```js
export const meta = { ... }            // name, rung, plain-english note
export function describe(policy)       // lines for `glafka guardrails`
export function check(policy, action)  // { allow } or { allow:false, reason }
```

The two walls are a different shape, because they do not inspect anything.
They change the world the agent runs in:

```js
export function buildEnv(policy, env)      // secrets.ts — what env survives
export function wrap(policy, cmd, opts)    // sandbox.ts — the real cage
```

---

## Levels

Each level is a full policy file in `levels/`. Diff two of them to see exactly
what one rung buys you.

| Level | Name       | What changes                                                  |
| ----- | ---------- | ------------------------------------------------------------- |
| 0     | `off`      | nothing enforced. audit off. today's behaviour.               |
| 1     | `observe`  | nothing blocked, but every action is logged. safe first step. |
| 2     | `standard` | doormen on. worktree only, command allow list, env scrubbed.  |
| 3     | `strict`   | + network allow list, tighter command list, no shell strings. |
| 4     | `locked`   | + real sandbox. no network at all. PR is the only exit.       |

**What each one actually costs you, honestly:**

- **2** is the one to use. A coder finishes an ordinary ticket without noticing it.
- **3** works, but expect to add a command or a host in the first week. Shell strings
  are refused, so `sh -c "..."` has to become a plain command. `curl` and `wget` are off.
- **4** needs docker or macOS `sandbox-exec`, and it allows **no network at all** — a
  hosted model (Claude, Gemini, any hosted endpoint) cannot reach its own API from
  inside it. Only a fully local model can run at level 4. `glafka guardrails --test`
  says so out loud rather than letting you find out mid-ticket.

---

## What the cage is for

Six points, so a new file can be checked against a rule instead of against a list of
past incidents.

- **The adversary is a confused coder, not a hostile one.** An LLM that misreads a
  path, follows a stale instruction, or improvises past its plan. Nothing here would
  survive a determined attacker with the same access.
- **It may touch the ticket's own worktree and its own scratch dir.** That is the whole
  allow list. Everything else is outside.
- **It must never touch anything that runs later, uncaged, as you.** `.git/hooks`,
  `.git/config`, the worktree's `.git` file and the `commondir`/`gitdir` files it
  points to (host git follows them after the cage), `.claude/`, `.cursor/`, `.gemini/`, `.opencode/`, `.kimi/`,
  `.kimi-code/`, `.github/skills/`, `.glafka.json`,
  `docs/glafka/guardrails.json`. That is the rule the deny list is derived from, and
  the test to apply to a new file: _does writing this cause code to run on the human's
  machine?_
- **It must never hold a secret it does not need.** The env is an allow list, not a
  deny list, so a variable added tomorrow is dropped by default.
- **Out of scope on purpose, 1:** a tool glafka does not model that carries no path and
  no command. Level 2 sets `onUnknownAction: "allow"`, so one reaches nothing a layer
  checks. Levels 3 and 4 deny unknowns. `glafka aporia`, `glafka krisis` and
  `glafka epalitheusis` do not depend on this setting: they are shell commands, and
  `glafka` (with those subcommands) is on the exec allow list at levels 2, 3 and 4. Keep it there — aporia is how a coder says
  "I am stuck", and if it is refused, a coder that gave up looks exactly like one that
  finished.
- **Out of scope on purpose, 2:** anything the coder edits that YOU then run —
  `package.json` scripts, a Makefile, a test file. Those are normal work and blocking
  them would block the job. They are **named at review and at push** instead
  (`layers/hostexec.ts`), because the answer there is reading, not refusing.

## Every command

```bash
glafka guardrails                    # what is on right now, and why
glafka guardrails --level 2          # preview a level, then save it
glafka guardrails --explain exec     # plain-English tour of one layer
glafka guardrails --backends         # what this machine can really enforce
glafka guardrails --test <id>        # run probes inside the real cage
glafka guardrails --install-hook     # install the hook into every harness
glafka guardrails --claim <id>       # bind THIS agent session to a ticket
glafka guardrails --log <id>         # what the agent tried, and what was refused
glafka guardrails --repin <id>       # accept a rules change for one ticket
```

### `--claim` — the one you have to know about

An in-session coder runs under whatever agent session you are already in, and
the hook is the only place that sees both that session's id and a ticket id.
Until a session claims a ticket, its tool calls are **unattributed**, and no
layer runs on them — the cage is configured and is not applied. So the coder
claims the ticket first:

```bash
glafka guardrails --claim <ticket-id>
```

It reports whether the claim was actually recorded, and exits non-zero if it was
not. `--background` runs do not need this: glafka spawns those itself and knows
which ticket they belong to. Check either case with `--log <id>`, which lists
every decision recorded for that ticket, including the ones marked
unattributed.

---

## Turning it on

Three steps. Run them on your main checkout:

```bash
glafka guardrails --level 2        # saves level 2 to docs/glafka/guardrails.json
glafka guardrails --install-hook   # wires the hook into every harness
```

Then start a **new** agent session. A session that was already open does not load
the new hook.

To narrow or widen from there, edit `docs/glafka/guardrails.json` — see
`example.project.json`.

---

## Where the policy lives, and why it matters

```
your repo/
├── docs/glafka/guardrails.json     ← READ FROM HERE (main checkout)
└── .worktrees/2026-08-07-add-dark-mode-to-settings/
    └── docs/glafka/guardrails.json ← the agent CAN edit this copy.
                                       nobody reads it.
```

A worktree is a full checkout, so the agent has its own copy of every tracked
file, including this one. It may edit that copy freely. glafka only ever reads
the main checkout.

Two extra locks on top:

1. The policy hash is recorded on the ticket when the ticket opens. If it
   changes mid-ticket, glafka refuses to continue.
2. A project override may only change the keys its level lists. Keys in
   `neverOverridable` are refused first. Narrowing works only for keys in
   `mayNarrow`, and widening only for keys in `mayWiden` (like `exec.allow`).
   A widening is recorded on the ticket, so a loosened rule shows up at
   review instead of hiding.

---

## Reading order, if you want to learn this

1. `levels/0-off.json` then `levels/2-standard.json` — diff them.
2. `layers/filesystem.ts` — the simplest doorman, and the symlink problem.
3. `layers/exec.ts` — why argv arrays beat command strings.
4. `layers/secrets.ts` — the cheapest real win in the whole folder.
5. `layers/sandbox.ts` — the wall.
6. `enforce.ts` — how a decision actually gets made.
