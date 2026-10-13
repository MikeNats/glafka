import fs from 'node:fs';
import path from 'node:path';

// Where each harness keeps its own `glafka-coder` definition, exactly as `glafka install` writes
// them. Same shape and same reasoning as HOOK_CONFIG_PATHS and PROJECT_HOOK_MARKERS: a list of
// files we own, checked by existence, kept in step with the installer.
//
// A file here is a DIFFERENT kind of "configured" from `agents.coder` in .glafka.json. That setting
// is a shell command glafka spawns itself. This one is a subagent the session's own harness spawns,
// which is the path genesis.md and ergon.md document for Claude Code — and it needs no entry in
// .glafka.json at all. Nothing used to look for these, so a project with a perfectly good
// `glafka-coder` was told "no coder subagent is configured" and did the work inline.
const NATIVE_CODER_PATHS: ReadonlyArray<{ harness: string; file: string; spawn: string }> = [
  {
    harness: 'Claude Code',
    file: '.claude/agents/glafka-coder.md',
    spawn: 'Agent(subagent_type="glafka-coder", run_in_background=True, prompt=<the prompt below>)',
  },
  {
    harness: 'Kimi Code CLI',
    file: '.kimi-code/agents/glafka-coder.yaml',
    spawn: 'Agent(subagent_type="glafka-coder", run_in_background=true, prompt=<the prompt below>)',
  },
  {
    harness: 'Cursor',
    file: '.cursor/agents/glafka-coder.md',
    spawn: '/glafka-coder <the prompt below>',
  },
  {
    harness: 'Gemini CLI',
    file: '.gemini/agents/glafka-coder.md',
    spawn: '@glafka-coder <the prompt below>  (blocks until it finishes)',
  },
  {
    harness: 'OpenCode',
    file: '.opencode/agent/glafka-coder.md',
    spawn: '@glafka-coder <the prompt below>  (blocks until it finishes)',
  },
];

export interface NativeSubagent {
  harness: string;
  file: string;
  spawn: string;
}

// Which harnesses define a `glafka-coder` here. Read-only, and looked up in the MAIN checkout: the
// session doing the reading runs there, not in the ticket's worktree, so that is where its harness
// resolves a subagent name from. Returns every match rather than the first — we cannot tell which
// harness is reading this, so the message names them all and lets the reader pick its own.
export function nativeCoderSubagents(repoRoot: string | null): NativeSubagent[] {
  if (!repoRoot) return [];
  return NATIVE_CODER_PATHS.filter(({ file }) => fs.existsSync(path.join(repoRoot, file))).map(
    ({ harness, file, spawn }) => ({ harness, file, spawn }),
  );
}
