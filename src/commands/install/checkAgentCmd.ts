import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { shellPath } from '../../util/shell.js';
import { CANDIDATE_CMD } from './agentCandidates.js';

// Reviews only ever spawned a separate process when someone hand-wrote an agent command into
// .glafka.json. Nobody knew to, so in practice no project ever got the fresh-context review the
// docs promise. install writes one now — but only after watching it work, because a command that
// merely LOOKS right is the expensive failure here: a bare `claude -p` reads its prompt, is refused
// write access, and exits 0, which glafka then records as a finished run (see config.ts).

// The whole probe. Small on purpose: it proves the CLI runs, takes a prompt on stdin, and answers —
// which is every property glafka needs from it. It does not prove the agent can WRITE files, and it
// is not meant to: the reviewer never writes.
const PROBE_PROMPT = 'Reply with exactly this word and nothing else: GLAFKAOK';
const PROBE_MARKER = 'GLAFKAOK';
const PROBE_TIMEOUT_MS = 90_000;

export interface ProbeResult {
  cmd: string | null;
  // Why nothing was written, in words meant for a person. Null when it worked.
  why: string | null;
}

// Whether the first word of a command is really runnable. Checked before spending an LLM call,
// because "that CLI is not installed" is by far the most common answer and the cheapest to give.
function onPath(binary: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (binary.includes(path.sep)) return fs.existsSync(binary);
  const suffixes = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const suffix of suffixes) {
      try {
        fs.accessSync(path.join(dir, `${binary}${suffix}`), fs.constants.X_OK);
        return true;
      } catch {
        // Not here, not executable, or a dangling symlink. Keep looking.
      }
    }
  }
  return false;
}

export type RunProbe = (cmd: string, prompt: string) => string;

const defaultRunProbe: RunProbe = (cmd, prompt) =>
  execFileSync(shellPath(), ['-c', cmd], {
    input: prompt,
    encoding: 'utf8',
    timeout: PROBE_TIMEOUT_MS,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

// Runs the candidate and reports whether it can be believed. Never throws: a probe that blows up is
// an answer ("this command does not work here"), not a reason to fail someone's install.
export function checkAgentCmd(
  platform: string,
  {
    run = defaultRunProbe,
    env = process.env,
    // Which role's candidate to probe. Defaults to the reviewer, so every existing
    // caller keeps the behaviour it had before a second role existed.
    role = 'reviewer',
  }: { run?: RunProbe; env?: NodeJS.ProcessEnv; role?: string } = {},
): ProbeResult {
  const cmd = CANDIDATE_CMD[role]?.[platform];
  if (!cmd) return { cmd: null, why: `no ${role} command is known for "${platform}"` };

  // The CLI's own name, not shellArgv's — that returns the shell that would run it.
  const binary = cmd.trim().split(/\s+/)[0];
  if (!binary || !onPath(binary, env)) {
    return { cmd: null, why: `${binary ?? platform} is not installed, or not on PATH` };
  }

  let output;
  try {
    output = run(cmd, PROBE_PROMPT);
  } catch (err) {
    const reason = (err as Error).message.split('\n')[0];
    return { cmd: null, why: `\`${cmd}\` failed to run — ${reason}` };
  }

  // Exit 0 is not enough. The bug this whole probe exists for is a command that exits 0 having
  // done nothing at all, so the answer itself has to come back.
  if (!output.includes(PROBE_MARKER)) {
    return {
      cmd: null,
      why: `\`${cmd}\` ran but did not answer — it may need different flags to work unattended`,
    };
  }
  return { cmd, why: null };
}

// Adds one `agents.<role>` to .glafka.json, and only that. An existing value is never touched: a
// project that configured its own agent means it, and a probe result must not overrule a person.
export function writeAgentCmd(
  repoRoot: string,
  role: string,
  cmd: string,
): { written: boolean; reason: string | null } {
  const filePath = path.join(repoRoot, '.glafka.json');
  let config: Record<string, unknown> = {};
  if (fs.existsSync(filePath)) {
    try {
      config = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    } catch {
      // Rewriting a file we cannot read would throw away whatever is in it.
      return { written: false, reason: '.glafka.json is not valid JSON — left alone' };
    }
  }
  const agents = { ...((config.agents as Record<string, unknown>) ?? {}) };
  if (agents[role]) return { written: false, reason: `a ${role} is already configured` };

  agents[role] = cmd;
  fs.writeFileSync(filePath, `${JSON.stringify({ ...config, agents }, null, 2)}\n`);
  return { written: true, reason: null };
}
