import fs from 'node:fs';
import path from 'node:path';

// How an AGENT should invoke glafka, as opposed to how a person does. Every prompt glafka builds
// tells the agent to run `glafka krisis`, `glafka aporia`, `glafka psyche` or `glafka guardrails
// --claim`. Those are the coder's only way to report an impasse, the reviewer's only way to file a
// finding one by one, and the session's only way to claim the guardrails hook. All of them were
// written as the bare word `glafka`. That is right for a person: the documented install is global
// (`npm install -g .`), and a human types into a shell that has it. It is not reliably right for an
// agent. `glafka install` vendors a complete copy into `.glafka/` and the skills all invoke it as
// `node .glafka/bin/glafka.js` — which only makes sense because the global one may be missing or
// stale. When it is, the agent silently loses those verbs, and glafka reports the result as _"it
// never called krisis"_: a statement about the agent's choice, describing a missing binary.
// The bare word is still preferred WHEN IT REALLY RESOLVES, and that
// ordering is deliberate. An agent's own permission allowlist is written by hand and is
// prefix-matched — `Bash(glafka:*)` is the rule a person writes, and it does not match `node
// /long/absolute/path/glafka.js`. Handing out the absolute form unconditionally traded one silent
// failure for another.

// Executable extensions to try. Empty string first, for POSIX.
const EXECUTABLE_SUFFIXES = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];

// Whether a bare `glafka` would resolve. PATH is scanned directly rather than shelling out to
// `which`: this runs while building a prompt, and a spawn per prompt is a cost with no benefit.
function onPath(env: NodeJS.ProcessEnv = process.env): boolean {
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const suffix of EXECUTABLE_SUFFIXES) {
      const candidate = path.join(dir, `glafka${suffix}`);
      try {
        // Existence is not enough on POSIX: a broken symlink from an old `npm link` exists as a link and
        // fails to execute. accept-X follows the link and asks whether it can actually be run.
        fs.accessSync(candidate, fs.constants.X_OK);
        return true;
      } catch {
        // Not here, not executable, or a dangling link. Keep looking.
      }
    }
  }
  return false;
}

export function glafkaCli(
  repoRoot: string | null,
  { env = process.env }: { env?: NodeJS.ProcessEnv } = {},
): string {
  if (onPath(env)) return 'glafka';

  // No global one. The vendored copy always works and needs nothing from PATH; the path is absolute
  // because the agent's working directory is the ticket's worktree, not the repo root.
  if (repoRoot) {
    const vendored = path.join(repoRoot, '.glafka', 'bin', 'glafka.js');
    if (fs.existsSync(vendored)) return `node ${vendored}`;
  }

  // Neither. Say the short form anyway — it is what the docs use, and a wrong-looking command an agent
  // reports back is more diagnosable than a path that points at nothing.
  return 'glafka';
}
