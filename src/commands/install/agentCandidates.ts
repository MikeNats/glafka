// The command each supported CLI is tried with, per role. Candidates, not knowledge: whichever one
// is picked is RUN before it is believed, so an entry that is wrong for a tool's current flags costs
// a failed probe and nothing else.
//
// Split out of checkAgentCmd.ts only to keep that file under the line limit.

// A reviewer reads and reports. It must not be able to edit, so where a CLI can express that, it
// does. These are candidates, not knowledge: whichever one is picked is run before it is believed,
// so an entry that is wrong for a tool's current flags costs a failed probe and nothing else.
const CANDIDATE_REVIEWER_CMD: Record<string, string> = {
  claude:
    "claude -p --permission-mode acceptEdits --allowedTools 'Read,Glob,Grep,Bash(git log:*),Bash(git diff:*),Bash(glafka:*)'",
  cursor: 'cursor-agent -p --force',
  gemini: 'gemini --yolo -p',
  opencode: 'opencode run',
  kimi: 'kimi --yolo -p',
  github: 'copilot -p --allow-all-tools',
};

// A reporter WRITES. `odysse`, `epistle`'s doc sync and architecture update, and the `genesis`
// drafts all resolve this role, and install used to write only the reviewer — so on every default
// install `reporter` was null and all of them printed their prompt instead of running it, at exit
// code 0, with nothing recorded as skipped. The tool knew: deliverPrompt's own comment says so. It
// fixed the message and left the installer producing the state.
//
// It must NEVER fall back to the reviewer command. That one is deliberately read-only, so a
// reporter given it is refused every write and exits 0 — which glafka records as a finished run,
// the exact failure the probe exists to prevent.
const CANDIDATE_REPORTER_CMD: Record<string, string> = {
  claude:
    "claude -p --permission-mode acceptEdits --allowedTools 'Read,Write,Edit,Glob,Grep,Bash(git log:*),Bash(git diff:*),Bash(glafka:*)'",
  cursor: 'cursor-agent -p --force',
  gemini: 'gemini --yolo -p',
  opencode: 'opencode run',
  kimi: 'kimi --yolo -p',
  github: 'copilot -p --allow-all-tools',
};

// A verifier (QA tester) runs curl and the project's CLI, so it gets every shell command. The claude
// one drops the edit TOOLS, but its shell can still write: only the worktree check catches an edit.
const CANDIDATE_VERIFIER_CMD: Record<string, string> = {
  claude:
    "claude -p --allowedTools 'Read,Glob,Grep,Bash' --disallowedTools 'Edit,Write,NotebookEdit'",
  cursor: 'cursor-agent -p --force',
  gemini: 'gemini --yolo -p',
  opencode: 'opencode run',
  kimi: 'kimi --yolo -p',
  github: 'copilot -p --allow-all-tools',
};

export const CANDIDATE_CMD: Record<string, Record<string, string>> = {
  reviewer: CANDIDATE_REVIEWER_CMD,
  reporter: CANDIDATE_REPORTER_CMD,
  verifier: CANDIDATE_VERIFIER_CMD,
};
