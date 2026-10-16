<!-- Athenian silver stater, late 6th-early 5th c. BC, Cleveland Museum
     of Art 1916.992.b — the owl (glaux) reverse only. CC0, via Wikimedia
     Commons. -->

<h1>
  <img src="https://upload.wikimedia.org/wikipedia/commons/2/26/Greece%2C_Athens%2C_late_6th-early_5th_century_BC_-_Stater-_Owl_%28reverse%29_-_1916.992.b_-_Cleveland_Museum_of_Art.jpg" width="52" align="middle" alt="An owl on an ancient Athenian silver coin" />
  glafka (sharp-eyed)
</h1>

**glafka enforces a structured workflow for coding agents: hard gates, with a human in the loop.**

Named after the ancient Greek symbol of wisdom the owl (γλαύξ, glaux) was the bird of goddess Athena. The sharp-eyed guardian blending autonomous agent intelligence with the hard gates of human wisdom.

```
idea → YOU ANSWER QUESTIONS → spec → plan → YOU APPROVE → code → checks → QA → review → ready
                                                           ▲                     │
                                                           └─ problems go back ──┘

ready → PR → You MERGE → clean up
```

## Install

Once, on your machine:

```bash
git clone https://github.com/MikeNats/glafka.git
cd glafka
npm install        # gets the build tools and builds glafka
npm install -g .   # puts the `glafka` command on your PATH
```

The global `glafka` command points to this folder. Keep the folder.

Then, inside each project's git repo:

```bash
cd your-project
glafka install claude           # name the agent you use
glafka install cursor gemini    # or several
glafka install --all            # or every platform
```

There is no default platform. Names: `claude` (Claude Code), `cursor`,
`gemini` (Gemini CLI), `kimi`, `opencode`, `github` (GitHub Copilot).

## How to use it

1. **Once per project:** run `/glafka:odysse`. It maps your code and works
   out how to run it. Then run `glafka odysse --checks` once, and keep the
   command it finds, so glafka knows how your project checks itself.
2. **For each ticket:** run `/glafka:genesis "<idea>"`.
   - The agent asks you questions, and you answer.
   - You pick the acceptance criteria, then you approve the plan.
   - A coder agent writes the code. glafka then checks, tests and reviews it.
3. **To raise the PR:** run `/glafka:epistle <id>`.
4. **After the PR is merged:** run `/glafka:lysis <id>` to clean up.

The agent tells you when to do steps 3 and 4. To see where your tickets are,
run `glafka poreia --all`.

**Plain words work too.** You are talking to an agent, so you can just say
what you want. An agent that picks commands by itself, like Claude Code, runs
the right one:

```
glafka genesis add dark mode to the settings page
glafka epistle raise the PR
glafka lysis clean up
```

## Features

- **Isolation** — every ticket gets its own git worktree, branch and ports.
  It can get its own database too.
- **Almost no setup** — `odysse` reads your project once. It writes how to
  run it: ports and database. You approve the rules and workspace settings it
  proposes. `odysse --checks` finds how to check it. Every later ticket reuses
  it. You can change it by hand in `isolation.json` (see
  [Per-ticket setup](#per-ticket-setup)).
- **Real checks** — glafka runs your project's own check command itself.
  It does not trust the agent's word.
- **Fresh review** — a fresh reviewer agent, with no shared context, reads
  the diff. A big diff gets a second reviewer, for the structure.
- **QA** — if the spec lists acceptance criteria, a fresh QA agent, with no
  shared context, tests each one on the running app, after a clean review.
- **Memory** — your project's rules and a map of your code live in
  `docs/glafka/` (git-tracked). They grow with every ticket:
  - while you plan, when you state a preference or correct the agent, it
    records that as a proposed rule. It can propose rules of its own too.
  - you keep or drop each one. Kept rules join the memory.
  - each PR updates the map for the parts of the code it changed.
  - the coder and the reviewer read the rules and the map on every ticket.
- **Audit trail** — every stage, agent run, review verdict, QA result and
  override is recorded. `glafka audit` shows what each run cost: time,
  outcome, and tokens when the agent reports them. With guardrails on, every
  action the coder tries is logged too.
- **Personas** — `teacher`, `dyslexic`, `creative`. One at a time. Add your own.
- **Guardrails** — limits on what the coder agent may touch. 5 levels.
  Off by default.
- **Many agents** — Claude Code, Cursor, Gemini CLI, Kimi, OpenCode,
  GitHub Copilot.
- **One dependency** — `zod`. Node built-ins do the rest.

In Greek myth, the owl (γλαύξ, glaux) was the bird of Athena, goddess of
wisdom. It could see clearly in the dark. **glafka** (γλαύκα) comes from the
same root.

## For agents

Everything below is the full reference. It is written for agents, and for
people who want the details.

- [Words used here](#words-used-here)
- [Commands](#commands)
- [What install adds](#what-install-adds)
- [Map the project](#map-the-project)
- [Start a ticket](#start-a-ticket)
- [Explore an idea](#explore-an-idea)
- [Raise a PR](#raise-a-pr)
- [Clean up](#clean-up)
- [The check loop](#the-check-loop)
- [What blocks a PR](#what-blocks-a-pr)
- [Run it unattended](#run-it-unattended)
- [Conventions and decisions](#conventions-and-decisions)
- [Personas](#personas)
- [Engineering standards](#engineering-standards)
- [Guardrails](#guardrails)
- [Configuration](#configuration)
- [Per-ticket setup](#per-ticket-setup)
- [Ticket names](#ticket-names)

### Words used here

- **ticket** — one piece of work. Its id is the date plus the idea.
- **worktree** — a second checkout in `.worktrees/<id>/`. The coder writes
  code only there. glafka writes the ticket's docs into `docs/glafka/` in the
  main checkout, uncommitted.
- **spec / plan** — `docs/glafka/tickets/<id>/spec.md` and `plan.md`.
- **acceptance criteria (AC)** — spec lines like
  `- AC-1: <start state> → <action> → <what you see>`.
- **checks** — the project's own test, lint and type commands.
- **review round** — one pass of checks, QA and review.
- **aporia** — the coder says "I am stuck, I need a person".
- **conventions** — project rules, in `docs/glafka/ethos/`.

### Commands

Installed into the agent, as `/glafka:<name>` (Claude Code, Gemini CLI),
`/glafka-<name>` (Cursor, OpenCode), `/skill:glafka-<name>` (Kimi), or the
`glafka-<name>` skill (GitHub Copilot):

| Command    | Greek meaning     | What it does                                             |
| ---------- | ----------------- | -------------------------------------------------------- |
| `odysse`   | the long journey  | Map the codebase. `--checks` finds how it checks itself. |
| `genesis`  | birth             | Start a ticket: spec, plan, code, checks, review.        |
| `heureka`  | "I found it"      | Explore an idea, with no fixed plan.                     |
| `ergon`    | work              | Write the code. `--review` runs checks, QA and review.   |
| `vima`     | a step            | Move a ticket forward by one step.                       |
| `epistle`  | a letter          | Raise a PR. It pushes the branch first.                  |
| `lysis`    | release           | Clean up a ticket after its PR is merged.                |
| `cancel`   | (English)         | Drop a ticket before it has a PR.                        |
| `prosopon` | a face, a persona | Turn a persona on or off.                                |

Terminal only (`glafka <command>`). The agent runs these in its own shell:

| Command        | Greek meaning | What it does                                            |
| -------------- | ------------- | ------------------------------------------------------- |
| `poreia`       | the route     | Ticket status. No LLM. `--all` lists every open ticket. |
| `logos`        | words         | Same status, re-worded by the `reporter`. Costs tokens. |
| `checks`       | (English)     | Run the checks. Saved only if all work is committed.    |
| `krisis`       | judgement     | Record a review verdict: clean or blocking.             |
| `epalitheusis` | verification  | Record a QA result for one acceptance criterion.        |
| `aporia`       | being stuck   | The coder asks a person for help.                       |
| `psyche`       | the mind      | Propose a project convention.                           |
| `apofasi`      | a decision    | Record a decision taken on one ticket.                  |
| `hygeia`       | health        | Safe npm dependency updates. npm projects only.         |
| `audit`        | (English)     | What each agent run cost: time, outcome, tokens.        |
| `guardrails`   | (English)     | Show or change the guardrails.                          |

- Also `install`, `version`, and `create`, `spec`, `plan`: the steps
  `/glafka:genesis` runs.
- `glafka genesis "<idea>"` in a terminal is not `/glafka:genesis`. It makes
  the worktree at once: no questions, no AC, no approval.
- `glafka <command> --help` shows the flags. Run it inside a git repo.
- No `glafka` on `PATH`: `node .glafka/bin/glafka.js <command>` from the repo
  root.

### What install adds

| Path                  | What it is                                                  |
| --------------------- | ----------------------------------------------------------- |
| `.glafka/`            | A copy of the glafka program for this project. Git-ignored. |
| `docs/glafka/skills/` | The steps each command gives the agent. Commit it.          |
| One folder per agent  | The glafka commands, plus a `glafka-coder` subagent.        |
| `.gitignore`          | Adds `.glafka/`, `.worktrees/` and `.env.glafka`.           |
| `.glafka.json`        | The agent commands glafka starts.                           |

- Copilot gets `.github/skills/` and no `glafka-coder`.
- Kimi gets `.kimi/skills/` and `.kimi-code/agents/`. Start Kimi with
  `kimi --agent-file .kimi-code/agents/glafka-coder.yaml` to use the coder.
- Install overwrites only glafka's own files: a path with a folder or file
  named `glafka` or `.glafka`, or one that starts with `glafka-`. It lists the
  files it skipped.
- For each of `reviewer`, `reporter` (writes docs) and `verifier` (QA), install
  sends the agent CLI a test prompt. If it answers, the command is saved in
  `.glafka.json`.
  - It never overwrites a value you set. It never sets `coder`.
  - The `verifier` is skipped if `agents.verifier`, `agents.default` or
    `GLAFKA_AGENT_CMD` is set. `reviewer` and `reporter` are added anyway, and
    then win over a default.
- `--with-standards` also adds review lanes and starter rules. See
  [Engineering standards](#engineering-standards).

**Upgrade:**

```bash
cd ~/path/to/glafka && git pull && npm install
cd ~/path/to/your-project && glafka install claude    # your platform(s)
```

Run it in every project. The reviewer and reporter test prompts run again,
up to 90 seconds each.

### Map the project

`/glafka:odysse` writes:

- a codebase map: one doc per folder that matters, plus an index at
  `docs/glafka/architecture/README.md`.
- `docs/glafka/architecture/isolation.json`, only if the project has an app
  or a database.
- proposed conventions. Keep them with `glafka odysse --keep all|none|1,3`.
- proposed workspace settings: base branch, install command, files to copy
  in, submodules. Keep them with `glafka odysse --workspace-keep all|none|1,3`.

`glafka odysse --checks` reads the CI config, task runner and manifests, and
finds the check command. It does not run it. It proposes one;
`--workspace-keep` saves it in `isolation.json` as `workspace.checksCmd`.
Kept at a real terminal, glafka runs it once and shows pass or fail.

- Both use the `reporter` agent. It does not run the check commands.

**No `checksCmd`:**

- glafka runs `npm run lint`, `typecheck` and `test`, if `package.json`
  defines them.
- It runs them once on the base commit when it makes a worktree. On a
  `genesis` ticket, a check that already failed there is not sent to the
  coder. glafka asks a person instead.
- Nothing to run: the review goes on, marked `checks-unknown`, and the PR is
  blocked. Set a `checksCmd` and run `glafka checks <id>`, or use
  `epistle --unreviewed`.

### Start a ticket

`/glafka:genesis "<idea>"`:

1. glafka makes the ticket.
2. The agent asks questions until the design is agreed. Then it reads the
   code.
3. The agent proposes acceptance criteria. The person keeps, changes or drops
   each. Each must be checkable by running the app.
4. The agent writes `spec.md` (AC at the end), then `plan.md`.
5. The person approves the plan. This is the only approval. Only then does
   glafka make the branch, worktree and ports, and start the app (`devCmd`).
6. A `glafka-coder` subagent writes the code: test first, one commit per step.
7. The check loop runs. See [The check loop](#the-check-loop).
8. The person keeps or drops recorded rules:
   `glafka ergon <id> --review --keep all|none|1,3`.
9. glafka stops. The agent tells the person to run `epistle`.

**Cancel:** `/glafka:cancel <id>` drops a ticket any time before it has a PR.
Before approval there is no worktree. The spec stays, and the name stays
taken. With uncommitted work in the worktree, cancel refuses; `--force`
throws it away.

### Explore an idea

`/glafka:heureka "<idea>"`: a worktree, branch and ports at once, plus a
database if `isolation.json` sets one up. No spec step, no plan, no AC, no
approval. The idea is saved as `spec.md`. After that it is a normal ticket:
`glafka ergon <id> --review`.

### Raise a PR

`/glafka:epistle <id>`, only when a person asks. In order, it:

1. checks the gates. See [What blocks a PR](#what-blocks-a-pr).
2. rebases the branch onto `origin/<base branch>`.
3. updates `plan.md` and the codebase map to match the code, and commits
   that. Two `reporter` agents do this. No `reporter`: nothing is updated, and
   the PR still goes ahead. `--no-tidy` skips this step.
4. pushes the branch to `origin`.
5. opens a PR with `gh`, or updates the branch's open PR.

The agent then tells the person to run `lysis` after the merge.

### Clean up

`/glafka:lysis <id>` closes the ticket, not the PR. Run it after the PR is
merged or closed. It stops the app, runs `teardownCmd`, removes the worktree,
and keeps the branch. It copies `decisions.md` and `audit.jsonl` into
`docs/glafka/tickets/<id>/`.

It refuses when:

- the PR is open.
- `gh` cannot reach GitHub. Check the PR by hand, then add `--pr-settled`.
- the worktree has uncommitted changes. `--force` throws them away.
- recorded rules wait for a decision. Add `--keep all|none|1,3`.

`glafka lysis <id> --sweep` closes the ticket, then lists leftovers:
worktrees and `glafka/*` branches with no open ticket (closed tickets'
branches included), stale lock files, and convention files whose category is
gone. It asks yes or no for each. With no terminal it only lists them;
`--kill all|none|1,3` decides.

### The check loop

```
  plan approved
        │
        ▼
     coder ◄──────────────────────────┐
        │ done                        │
        ▼                             │
     checks ── a new check fails ─────┤
        │ pass, or nothing to run     │
        ▼                             │
     QA (if AC) ── a criterion fails ─┤
        │ all pass                    │
        ▼                             │
     review ── blocking ──────────────┘
        │ clean, recorded with krisis
        ▼
     ready
```

1. **Coder** works in the worktree, and commits after each step.
2. **Checks.** glafka runs them itself.
   - A check fails that did not fail before this ticket → back to the coder.
   - Every failing check also failed on the base commit → stops for a
     person. Only when glafka guessed the checks.
   - Nothing ran → on to QA, marked `checks-unknown`.
3. **QA**, only if the spec has AC. A fresh QA agent (the `verifier`) uses the
   running app from outside: curl or the CLI. It records pass, fail or cannot
   per criterion, with evidence.
   - A fail → back to the coder, with what the tester saw.
   - Cannot, a missing result, or code that changed during QA → stops. This
     wins over a fail.
   - A pass without this round's token → stops. A fail wins over it.
   - A pass on uncommitted files → stops. Commit them first.
4. **Review.** A fresh reviewer reads the diff. Over 15 files or 800 changed
   lines, a second reviewer checks the structure.
   - Blocking, from any reviewer → back to the coder, with the findings. It
     wins over another reviewer's clean.
   - Clean, recorded with `glafka krisis` and this round's token → ready.
   - Clean only in the reviewer's text, or no verdict → stops.

A coder sent back gets a note: the failed criteria, or else the reviewer's
findings. After failed checks, the note says nothing about the checks. It
may repeat the last QA or review note.

**Also stops for a person when:**

- the coder is stuck: it ran `glafka aporia`, or its last line was
  `STUCK: <reason>`.
- the coder committed nothing.
- the guardrails changed since the ticket opened.
- QA is due and no `verifier` agent is set. A person runs
  `glafka ergon <id> --review` at a real terminal.
- the round limit is reached.

A person can skip one criterion, at a real terminal:
`glafka epalitheusis <id> --skip AC-3 --reason "<why>"`. It is saved with the
ticket's decisions.

**In the agent session** (what `/glafka:genesis` does):

1. The session starts a `glafka-coder` subagent.
2. When done, the coder runs `glafka ergon <id> --review` itself. This runs
   the checks, then starts the next agent in its own process:
   - AC in the spec → the QA agent. When QA passes,
     `glafka ergon <id> --review --status` starts the reviewer.
   - no AC → the reviewer. A big diff gets two.
3. The coder fixes what comes back, commits, and runs `--review` again.

- No round limit in this mode.
- No `reviewer` agent: `--review` prints the review brief instead. The clean
  token is shown only at a real terminal, so the coder is not handed it.

**Unattended:** `glafka vima`. Every agent is a new process. See
[Run it unattended](#run-it-unattended).

**Round limit:** only `vima` uses it (`maxReviewRounds`, default 3). A round
counts when the coder ran since the last one. Failed checks and failed QA
count. At the limit, `vima` stops and asks a person.

### What blocks a PR

`glafka epistle` refuses when any of these is true.

**Always:**

- a coder or reviewer that glafka started is still running.
- the last coder run crashed, timed out, was stopped, or failed its checks.
- the guardrails changed since the ticket opened.
- the last review recorded failing checks.
- the review ran no checks, and `glafka checks <id>` then FAILED.
- an AC has not passed on this exact committed code.
- the reviewer found a blocking problem.
- `.env.glafka` is in the branch, or the rebase fails.
- the worktree is not on the ticket's branch, or HEAD is detached.
- something during the tidy-up committed more than the codebase map and the
  ticket's docs, or rewrote the history.

**`--unreviewed` skips these.** It is written on the ticket, and at the top
of the PR when glafka opens it.

- no review since the last code change. A commit by hand counts. A commit
  that changes only the codebase map or the ticket's docs does not.
- no trusted clean verdict: none, a failed reviewer, or clean only in its
  text.
- the review ran no checks. Or run `glafka checks <id>`, then `epistle` again.

### Run it unattended

```bash
glafka vima <id>      # one step for one ticket
glafka vima --all     # one step for every open ticket
```

- One step: start a coder, a QA agent or a reviewer, or report "ready" or
  "needs you". Run it on a timer, for example cron.
- It never pushes, never closes, never asks a question.
- Agent command per role: `agents.<role>`, then `agents.default`, then
  `GLAFKA_AGENT_CMD`. Roles: `coder`, `reviewer`, `verifier`. With only
  `GLAFKA_AGENT_CMD`, the coder's command also reviews and runs QA.
- The id is optional: the current folder, then the git branch, then the only
  open ticket. Otherwise it lists the open ids and stops.
- `notifyCmd` runs once when a ticket is ready or needs a person.
- A commit by hand after a clean review: "needs you". vima never pays for a
  review of it.
- `vima` runs get no persona.

**Time limit** (`ergonTimeoutMs`, 60 minutes), checked on each step:

- coder: killed. A "needs you" message, but the next step starts a new
  coder if the round limit allows.
- reviewer: killed. Stops for a person.
- QA agent: killed. The next step closes its round. A missing result stops.

**Stop or restart:**

- `glafka ergon <id> --stop` stops a coder glafka started. The next step can
  start a new one. `--review --stop` stops the reviewers and QA agent.
- `glafka cancel <id>` stops a ticket for good.
- `glafka vima <id> --restart` restarts the ticket's app. `--all --restart`
  restarts every app.

### Conventions and decisions

**Conventions** are rules for the whole project.

- While the person brainstorms, plans or explores, the agent records stated
  preferences in their words: `glafka psyche <id> --code "<rule>"`. It can
  propose rules of its own. The coder and reviewer are told not to record
  rules. Nothing blocks them.
- Every rule is a proposal. The person keeps or drops each after the review:
  `glafka ergon <id> --review --keep all|none|1,3`.
- Kept rules go under `## Learned` in `docs/glafka/ethos/`. Hand-written
  rules go under `## Authored`; glafka never edits or removes them.
- A rule for some files only: `"[scope: **/migrations/**] <rule>"`.
- `glafka odysse --compact` proposes rules to merge or retire.
- Categories: `docs/glafka/ethos/categories.json`, a list of
  `{ "name": "CODE", "hint": "..." }`. Each becomes a `psyche` flag. Default
  ten: code, design, architecture, testing, security, performance, ai,
  workspace, technologies, infrastructure.

**Decisions** belong to one ticket: `glafka apofasi <id> "<decision, and why>"`.
The coder reads them; a decision beats the plan. On close or cancel they are
copied to `docs/glafka/tickets/<id>/decisions.md`.

**Destination:** `docs/glafka/proorismos.md`, written by hand. `heureka` and
`glafka genesis --draft` weigh new ideas against it.

### Personas

`/glafka:prosopon <name>` changes how glafka writes to the person:
brainstorming, the coder's report, the reviewer's findings, `logos`. Not
`vima` runs.

- Shipped: `teacher`, `dyslexic`, `creative`. One at a time. Name the active
  one again to turn it off. `--clear` turns all off.
- Own personas: `docs/glafka/personas/<name>.md`. Same name as a shipped one
  wins.
- Which one is on is saved per project, in `.glafka/persona`.
- The coder and reviewer prompts say: change the wording only, never the
  sections.

### Engineering standards

`glafka install <platform> --with-standards`. Nothing is written without it.

- `docs/glafka/standards/`: `how-to-review.md` plus 5 lanes (security,
  correctness, testing, performance, design). Read by the reviewer. Rerun
  overwrites them, except a file with uncommitted edits.
- `docs/glafka/ethos/`: about 30 starter rules under `## Authored`. Read by
  the coder and reviewer. Rerun adds only missing rules; a deleted starter
  rule comes back. Rules go only into categories that exist.
- `reviewDoc` in `.glafka.json`: the project's own review doc, for the
  reviewer. Works without the flag.

The content is generic: no language, framework or vendor. It draws on
[OWASP Top 10](https://owasp.org/Top10/2025/),
[Google's code-review guide](https://google.github.io/eng-practices/review/reviewer/looking-for.html),
ports-and-adapters, and well-known design patterns.

### Guardrails

Limits on what the coder may touch. Off by default (level 0). To turn on, on
the base branch:

1. `glafka guardrails --level 2` — saves `docs/glafka/guardrails.json`, and
   commits it.
2. `glafka guardrails --install-hook` — installs the hook for every agent,
   and commits it. The Kimi hook is global, for every project.
3. Start a new agent session.

| Level | Name     | What changes                                                                  |
| ----- | -------- | ----------------------------------------------------------------------------- |
| 0     | off      | Nothing is enforced. The default.                                             |
| 1     | observe  | Nothing is blocked. Every action is logged.                                   |
| 2     | standard | File edits stay in the worktree. Dangerous commands blocked. Secrets removed. |
| 3     | strict   | Only listed commands start. A list of allowed hosts.                          |
| 4     | locked   | A real OS sandbox (docker or macOS). No network.                              |

Level 0 is the default. It trusts the agent fully, so read every PR before you
merge. Details on levels 1–4:

- Level 2 blocks a fixed list (`git push`, `gh`, `ssh`…) and some flags
  (`node -e`, `python3 -c`, `npm -g`…). Other commands run.
  It refuses `>`. Level 3 also refuses `$VAR`, `$( )` and backticks, and
  denies anything not listed.
- Level 2 keeps file edits and a few commands (`cp`, `mv`, `tee`…) in the
  worktree. Other commands are not path-checked.
- Level 3 lists `node`, `python3` and `npx`, so they can still run any code.
  Levels 2–3 stop a confused coder, not a hostile one. Use level 4 for that.
- Level 3's host list is advice only, unless `GLAFKA_PROXY_URL` points to a
  filtering proxy.
- Level 4: no network, not even localhost. A hosted model cannot reach its
  API.
- Levels 3–4: the QA agent cannot run curl, so web-app QA ends "cannot".
- From level 1: if the branch changed files that run on the host
  (`package.json`, `Makefile`, `*.sh`, CI workflows), checks do not run.
  Read them, then `epistle --unreviewed`.
- At every level: if the branch changed `package.json` and there is no
  `checksCmd`, its npm scripts do not run.
- Each ticket pins a fingerprint of the rules. A changed level, or changed
  hook files in its worktree, blocks the ticket until
  `glafka guardrails --repin <id>`. Hooks installed later do not reach open
  tickets.
- An in-session coder runs `glafka guardrails --claim <id>` first. Before
  that, no rule applies to it.
- The sandbox, secret removal and proxy apply only to agents glafka starts
  itself, not a subagent in the session.
- Cursor cannot block file writes.

More: `glafka guardrails`, `--explain <layer>`, `--backends`, `--test <id>`,
`--log <id>`. See [installKit/guardrails/README.md](installKit/guardrails/README.md).

### Configuration

`.glafka.json` at the repo root. Optional; every key has a default. A wrong
value or unknown key stops glafka. Role names inside `agents` are not
checked.

```json
{
  "agents": {
    "coder": "claude -p --permission-mode acceptEdits --allowedTools 'Read,Write,Edit,Glob,Grep,Bash(npm test),Bash(git add:*),Bash(git commit:*),Bash(glafka:*)'",
    "reviewer": "claude -p --permission-mode acceptEdits --allowedTools 'Read,Glob,Grep,Bash(git log:*),Bash(git diff:*),Bash(glafka:*)'",
    "reporter": "claude -p --permission-mode acceptEdits --allowedTools 'Read,Write,Edit,Glob,Grep,Bash(git log:*),Bash(git diff:*),Bash(glafka:*)'",
    "verifier": "claude -p --allowedTools 'Read,Glob,Grep,Bash' --disallowedTools 'Edit,Write,NotebookEdit'"
  },
  "checksCmd": "npm test",
  "baseRef": "main",
  "maxReviewRounds": 3
}
```

- Agent commands must work with nobody watching. A bare `claude -p` asks for
  permission, nobody answers, and it exits as if it succeeded. Give rights
  with the agent's own flags.
- The `reporter` does not run check commands: `odysse --checks` only finds
  them. The `verifier` needs a shell, but must not edit files: a worktree
  change makes its QA round untrusted.
- Which command runs: `agents.<role>`, then `agents.default`, then
  `GLAFKA_AGENT_CMD`.

| Key                      | Default               | What it is                                                      |
| ------------------------ | --------------------- | --------------------------------------------------------------- |
| `agents`                 | `{}`                  | Roles: `coder`, `reviewer`, `reporter`, `verifier`, `default`.  |
| `checksCmd`              | `null`                | Unset: `workspace.checksCmd`, then npm scripts.                 |
| `e2eCmd`                 | `null`                | Runs after the checks. Unset: `workspace.e2eCmd`.               |
| `baseRef`                | found for you         | Then `workspace.baseRef`, then git, then `main`.                |
| `maxReviewRounds`        | `3`                   | Review rounds before `vima` stops.                              |
| `reviewDoc`              | `null`                | The project's own review doc, for the reviewer.                 |
| `notifyCmd`              | `null`                | Runs once when `vima` finds a ticket ready or needing a person. |
| `portRange`              | `4100`– `4199`        | Where ticket ports come from: `{ "start", "end" }`.             |
| `observability`          | `{ "enabled": true }` | Records each agent run, for `glafka audit`.                     |
| `ergonTimeoutMs`         | `3600000` (60 min)    | Background coder, reviewer and QA runs.                         |
| `checksTimeoutMs`        | `600000` (10 min)     | `checksCmd`.                                                    |
| `e2eTimeoutMs`           | `600000` (10 min)     | `e2eCmd`.                                                       |
| `bootstrapTimeoutMs`     | `900000` (15 min)     | Installing a worktree's dependencies.                           |
| `isolationHookTimeoutMs` | `300000` (5 min)      | `setupCmd`, `seedCmd`, `e2e.setupCmd`, failed-setup teardown.   |

- `workspace.*` keys live in `isolation.json`.
- Foreground agents (the `reporter`, or `glafka ergon <id>` with a coder
  command) have no time limit. `teardownCmd` on close always gets 5 minutes.
  `wakeCmd` has none.

### Per-ticket setup

`docs/glafka/architecture/isolation.json`, written by `odysse`. Editable.

| Key           | What it does                                                                 |
| ------------- | ---------------------------------------------------------------------------- |
| `services`    | Services and the env vars for their ports. Without it: one port, `PORT`.     |
| `setupCmd`    | Runs when the worktree is made. `KEY=VALUE` output goes to `.env.glafka`.    |
| `seedCmd`     | Fills the ticket's database. Runs after `setupCmd`, and sees its values.     |
| `wakeCmd`     | Brings stopped services back. Must be safe to run when nothing is wrong.     |
| `devCmd`      | Starts the app on the ticket's ports, with `.env.glafka`.                    |
| `healthCmd`   | Readiness check. Without it, glafka waits for the ports.                     |
| `teardownCmd` | Runs on close, on cancel, and when setup fails.                              |
| `e2e`         | `services`, `setupCmd`, `teardownCmd` for end-to-end tests.                  |
| `workspace`   | `baseRef`, `bootstrapCmd`, `checksCmd`, `e2eCmd`, `seedFiles`, `submodules`. |

- `setupCmd`: only keys in capital letters are saved, for example
  `DATABASE_URL`.
- `wakeCmd` runs before `glafka ergon` or `vima` starts a coder or a QA
  round. If it fails, nothing starts, and `vima` asks a person.
- `devCmd` starts with the worktree. `ergon` and `vima` restart it if it
  stopped.
- `bootstrapCmd` installs dependencies. `seedFiles` are git-ignored files to
  copy in, like `.env`. Kept with `glafka odysse --workspace-keep`.
- Bootstrap, setup, seed, wake, dev and health commands get
  `GLAFKA_TICKET_ID`, `GLAFKA_REPO_ROOT`, `GLAFKA_WORKTREE` and the port
  variables.
- Unknown keys are ignored, not refused.

### Ticket names

- The id is the date (UTC) plus the idea, cleaned and cut to 40 characters:
  `add dark mode to settings` → `2026-08-07-add-dark-mode-to-settings`.
- The worktree (`.worktrees/<id>/`), branch (`glafka/<id>`) and docs use it.
- Only `a-z` and `0-9` stay. Capitals become small letters. Each run of
  other characters becomes one `-`. A `-` at the start or end is dropped.
- The same name twice is refused. A closed or cancelled ticket keeps its name.
- No Latin letters: `glafka create "φτιάξε το σύστημα" --name "fix the system"`.

## Contributing

**Before you push:** `npm run check` (format and lint), `npm run typecheck`,
`npm test`.

- CI runs the tests on Linux, macOS and Windows. It runs format, lint and
  typecheck once, on Linux.
- Lint limits for new code: at most 100 lines per file, and 60 per function.
  Blank lines and comments do not count. Older files listed in
  `eslint.config.js`, and the tests, are exempt.

**Where a type lives:**

```
installKit/bin/types/         CLI shapes (CommandContext)
src/types/                    domain shapes (Ticket, Config, PromptContext, ...)
installKit/guardrails/types/  guardrails shapes (Action, Policy, TicketGuardrailsPin)
```

A type goes in a shared `types/` folder **only if more than one file uses it**.

**Pass the typed object. Do not destructure at every step.** Rename once,
where you use it, so the origin stays visible:

```ts
const { id: ticketId, worktree: worktreePath } = ticket; // origin visible here
```

A function that takes a known shape types it as that shape:
`Pick<Ticket, 'id' | 'worktree'>`, not three loose strings.

**zod at trust boundaries, plain types everywhere else.**

- Validate what comes from outside: `.glafka.json`, `isolation.json`,
  `docs/glafka/guardrails.json`, ticket files on disk, agent hook payloads.
- Derive the TypeScript type with `z.infer<>`, so the shape is defined once.
- Do not use zod for subprocess output or internal data.

**`any` is a lint error.** The rule: data from outside is `unknown`, narrowed
by a zod parse. Do not cast it with `as SomeType`.

**Guardrails code:** code in `src/` imports it only through
`installKit/guardrails/index.js`. A lint rule checks `src/`. The one exception
is `src/types/ticket.ts`.

## Requirements

- **Node.js 22** or newer.
- **git.** Your project must be a git repo with at least one commit.
- **An agent CLI** on your `PATH`, for example Claude Code (`claude`).
  glafka starts it for the reviewer, the QA tester, doc updates and
  unattended runs.
- **GitHub CLI** (`gh`), logged in, and a git remote named `origin`.
  You need them to open a PR, and to close a ticket that has a PR.
- **Optional: the [Superpowers](https://github.com/obra/superpowers) skills.**
  The glafka skills say which one to use at each step. In Claude Code, run:
  `/plugin install superpowers@claude-plugins-official`
  For other agents, `glafka install` prints the command for yours.

## License

[MIT](LICENSE)
