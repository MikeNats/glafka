// Aliased: `spawn` is already the name of a harness's subagent command in the
// handover text below, and the two must not be confused.
import { spawn as spawnProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildEnv, wrap as cage, proxyEnv } from '../../guardrails/index.js';
import type { Policy } from '../../guardrails/types/policy.js';
import { RunNotStartedError } from '../../../src/ticket/background.js';
import { shellArgv } from '../../../src/util/shell.js';
import { startRun, recordHandover } from '../../../src/audit/recordRun.js';
import { AUDIT_STAGES, type AuditStage } from '../../../src/audit/record.js';
import { withUsageFlags } from '../../../src/audit/usageFlags.js';
import { logText } from '../../../src/audit/logText.js';
import { ROLES, type Role } from '../../../src/types/ticket.js';
import { nativeCoderSubagents } from './nativeSubagent.js';

// With no agent command set, we just print the prompt. With one set, we run it and return true once
// it has finished. `agentCmd` comes from the caller, which has the project config; it is the same
// value `resolveAgentCmd` gives every other spawn. Reading the env var here instead meant
// `.glafka.json`'s `agents.*` was ignored on this path alone, so the same setting gave two
// different answers depending on which command you ran. The env fallback stays,
// last, because `resolveAgentCmd` ends there too.
// Said before the prompt, and only when there is no subagent to hand it to. Imperative on purpose:
// "no reviewer configured" is a fact about the setup, and the agent reading it needs an instruction.
const HANDOVER: Record<Role, string> = {
  [ROLES.REVIEWER]:
    `--- no reviewer subagent is configured, so THIS REVIEW IS YOURS. Nothing is running, ` +
    `nothing failed, and there is nothing to wait for. Do the review below yourself, now, then ` +
    `record the verdict with the krisis command printed underneath it. ---`,
  [ROLES.CODER]:
    `--- no coder subagent is configured, so THIS WORK IS YOURS. Nothing is running, nothing ` +
    `failed, and there is nothing to wait for. Follow the plan below yourself, now. ---`,
  [ROLES.REPORTER]:
    `--- no subagent is configured, so THIS IS YOURS. Nothing is running, nothing failed, and ` +
    `there is nothing to wait for. Do what the instructions below ask, yourself, now. ---`,
  [ROLES.VERIFIER]:
    `--- no verifier subagent is configured, so THIS VERIFICATION IS YOURS. Nothing is running, ` +
    `nothing failed, and there is nothing to wait for. Verify the acceptance criteria below yourself, now. ---`,
};

// Which .glafka.json key would have spawned this role, named per role so the reader is not sent
// hunting. `install` only ever writes `agents.reviewer`, so `reporter` — odysse, the epistle doc
// sync, the genesis drafts — resolves to null on every default install, which is what made this
// message a lie rather than a fact. It must NOT fall back to the reviewer command: that one is
// deliberately read-only, and a reporter writes files, so it would be refused every write and exit
// 0, which glafka records as a finished run.
const MISSING_KEY: Record<Role, string> = {
  [ROLES.REVIEWER]: `"agents": { "reviewer": "…" }`,
  [ROLES.CODER]: `"agents": { "coder": "…" }`,
  [ROLES.REPORTER]: `"agents": { "reporter": "…" }  (or "default")`,
  [ROLES.VERIFIER]: `"agents": { "verifier": "…" }`,
};

// The handover, plus the two things the bare fact left out: which setting is missing, and — for the
// coder — that this project may already define a subagent the SESSION can spawn without any setting
// at all. genesis.md and ergon.md document exactly that path, so a message flatly denying it made
// the docs and the tool contradict each other, and a literal reader does the work inline.
function handoverFor(role: Role, repoRoot: string | null): string {
  // Only the coder has a harness-native equivalent — `glafka-coder` is the only subagent
  // `install` writes a definition for on any platform.
  const native = role === ROLES.CODER ? nativeCoderSubagents(repoRoot) : [];
  const lines: string[] = [];

  if (native.length > 0) {
    // The HEADLINE has to change, not just gain a footnote. "THIS WORK IS YOURS" followed by
    // "actually, spawn the subagent" leaves the first imperative standing, and the first imperative
    // is the one a literal reader obeys — which is exactly what happened in a real run.
    lines.push(
      `--- no coder agent COMMAND is set in .glafka.json, but this project DOES define a ` +
        `\`glafka-coder\` subagent (${native.map((n) => n.harness).join(', ')}). ` +
        `SPAWN IT and hand it the prompt below — do not do this work inline. ` +
        `Nothing is running and nothing failed. ---`,
    );
    for (const { harness, spawn } of native) lines.push(`      ${harness}:  ${spawn}`);
    lines.push(
      `    Only if your harness is not listed, or the spawn fails, is the work yours: ` +
        `follow the plan below yourself.`,
    );
  } else {
    lines.push(HANDOVER[role] ?? HANDOVER[ROLES.REPORTER]);
  }

  lines.push(
    `    (to spawn one automatically instead, set ${MISSING_KEY[role] ?? MISSING_KEY[ROLES.REPORTER]} ` +
      `in .glafka.json — it must edit files WITHOUT asking)`,
  );
  return lines.join('\n');
}

// A non-zero exit. Its own class so the message names the agent rather than
// reading as an internal spawn failure — execFileSync's own error said
// "Command failed" and nothing about which agent, or with what code.
export class AgentFailedError extends Error {
  readonly exitCode: number | null;
  constructor(agentCmd: string, exitCode: number | null) {
    super(`agent exited ${exitCode ?? 'on a signal'}: ${agentCmd}`);
    this.name = 'AgentFailedError';
    this.exitCode = exitCode;
  }
}

// Runs the agent, showing its output as it arrives AND keeping a copy.
//
// It used to be execFileSync with stdout inherited, which meant glafka never
// saw a word of it: every run this path recorded had `tokens: null`, and
// epistle — two agent runs on every push — reported no cost at all. Inherited
// output cannot be read; read output does not print itself. So we pipe, and do
// the printing here.
//
// What is echoed goes through logText first, because an agent asked for its
// token counts answers in stream-json, and raw JSON on the terminal is not
// something anyone can watch. The RAW text is what comes back, though — that
// is what parseUsage reads the counts out of.
function runAgent(
  cmd: string,
  args: string[],
  { prompt, cwd, env }: { prompt: string; cwd?: string; env: NodeJS.ProcessEnv },
): Promise<{ exitCode: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(cmd, args, {
      stdio: ['pipe', 'pipe', 'inherit'],
      cwd,
      env,
    });

    let raw = '';
    // Whole lines only: logText parses one JSON object per line, and half an
    // object printed early is noise that never gets completed.
    let pending = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      raw += chunk;
      pending += chunk;
      const lines = pending.split('\n');
      // The last piece has no newline yet, so it waits for the next chunk.
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const said = logText(line);
        if (said !== '') process.stdout.write(`${said}\n`);
      }
    });

    child.on('error', reject);
    child.on('close', (code) => {
      // Whatever the last chunk left behind. A run that ends without a final
      // newline still said it.
      if (pending !== '') {
        const said = logText(pending);
        if (said !== '') process.stdout.write(`${said}\n`);
      }
      resolve({ exitCode: code, output: raw });
    });

    // The prompt goes in on stdin, the same way execFileSync's `input` did.
    child.stdin.end(prompt);
  });
}

export async function deliverPrompt(
  prompt: string,
  {
    cwd,
    policy = null,
    stateDir,
    agentCmd: configured = null,
    // The MAIN checkout, only ever read to name a harness-native subagent in the handover below.
    // Separate from `cwd`, which for a coder is the ticket's worktree — the session that reads this
    // message is not running there, so its harness resolves a subagent name somewhere else.
    repoRoot = null,
    ticketId = null,
    stage = AUDIT_STAGES.DELIVER,
    // Same default resolveAgentCmd's own role param has nowhere to read
    // from — the two genesis draft prompts, which run no coder or reviewer.
    role = ROLES.REPORTER,
    observability = false,
  }: {
    cwd?: string | null;
    policy?: Policy | null;
    stateDir?: string;
    agentCmd?: string | null;
    repoRoot?: string | null;
    ticketId?: string | null;
    stage?: AuditStage;
    role?: Role;
    // Default false: a caller that has not been updated records nothing,
    // rather than recording a run under the wrong stage.
    observability?: boolean;
  } = {},
): Promise<boolean> {
  const agentCmd = configured ?? process.env.GLAFKA_AGENT_CMD;
  if (!agentCmd) {
    // The prompt below is written FOR a subagent, and with none to spawn it lands in front of the
    // session's own agent with nothing saying whose job it now is. One read that as a step that had
    // failed to start, reported the review as blocked, and stopped — with the whole brief on screen.
    console.error(handoverFor(role, repoRoot));
    console.log(prompt);
    // Handed to the session is still work done on this ticket. Recorded here
    // because nothing else ever will: no process starts, so nothing finishes.
    recordHandover({
      stateDir: stateDir ?? null,
      ticketId,
      stage,
      role,
      promptBytes: Buffer.byteLength(prompt),
      enabled: observability,
    });
    return false;
  }

  // Asks claude for the machine output that carries its token counts, exactly
  // as the background path does. Every other agent, and anything with a pipe
  // or an output format of its own, comes back untouched.
  let argv = shellArgv(withUsageFlags(agentCmd));
  let env: NodeJS.ProcessEnv = process.env;
  // Held out here so the finally at the bottom can remove it.
  // Null when no policy was passed, because then none is ever made.
  let scratch: string | null = null;

  if (policy) {
    if (!cwd) {
      throw new Error(
        'deliverPrompt: cwd is required when a policy is passed (cage needs a worktree to scope to)',
      );
    }
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'glafka-deliver-'));
    const built = buildEnv(
      policy,
      process.env,
      {
        TMPDIR: scratch,
        GLAFKA_TICKET_SCRATCH: scratch,
        ...proxyEnv(policy, process.env),
      },
      // Which agent this really is, so a credential that belongs to a
      // different one is not handed over.
      { agentCmd },
    );
    env = built.env;

    // The cage goes on last, so it wraps the real final command — same
    // ordering spawnBackground uses.
    const caged = cage(policy, argv, {
      worktree: cwd,
      scratch,
      env,
      stateDir: stateDir ?? scratch,
    });

    // A cage that was asked for and did not start makes the run WRONG,
    // not just weaker. Refuse rather than run the agent uncaged.
    if (policy.sandbox.enabled && caged.failed) {
      throw new RunNotStartedError(
        `guardrails level ${policy.level} asks for a sandbox and it could not be started ` +
          `(${caged.note}) — refusing to run the agent uncaged.`,
      );
    }

    argv = caged.argv;
  }

  const run = startRun({
    stateDir: stateDir ?? null,
    ticketId,
    stage,
    role,
    agentCmd,
    promptBytes: Buffer.byteLength(prompt),
    enabled: observability,
  });

  const [cmd, ...rest] = argv;
  try {
    const { exitCode, output } = await runAgent(cmd!, rest, {
      prompt,
      cwd: cwd ?? undefined,
      env,
    });
    run.finish({ exitCode, output });
    // execFileSync used to throw this for us, and callers still rely on a
    // failed agent being an exception rather than a quiet `true`.
    if (exitCode !== 0) throw new AgentFailedError(agentCmd, exitCode);
    return true;
  } finally {
    // execFileSync is synchronous, so the agent has exited and nothing reads this.
    // In a finally, because a failing agent leaves the most scratch, not the least.
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  }
}
