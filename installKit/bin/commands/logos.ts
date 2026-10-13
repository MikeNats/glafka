import { execFileSync } from 'node:child_process';
import { AUDIT_STAGES } from '../../../src/audit/record.js';
import { ROLES } from '../../../src/types/ticket.js';
import { logos } from '../../../src/commands/logos/logos.js';
import { resolveAgentCmd, EXAMPLE_AGENT_CMD } from '../../../src/config.js';
import { buildEnv } from '../../guardrails/index.js';
import { resolvePolicy } from '../../guardrails/index.js';
import type { CommandContext } from '../types/cli.js';
import { shellPath } from '../../../src/util/shell.js';
import { assertKnownFlags } from '../cli/args.js';
import { startRun } from '../../../src/audit/recordRun.js';

// A report should not take longer than the thing it describes.
const REPORTER_TIMEOUT_MS = 60 * 1000;

// The reporter only re-words text handed to it on stdin. It is given the scrubbed environment anyway
// — a command that never needs a secret should never hold one.
function renderWithAgent({
  agentCmd,
  prompt,
  repoRoot,
  stateDir,
  observability,
}: {
  agentCmd: string;
  prompt: string;
  repoRoot: string;
  stateDir: string | null;
  observability: boolean;
}): string {
  const { policy } = resolvePolicy({ repoRoot });
  const { env } = buildEnv(policy, process.env, {});
  // A report is an agent run like any other, and it is billed like one.
  const run = startRun({
    stateDir,
    ticketId: null,
    stage: AUDIT_STAGES.LOGOS,
    role: ROLES.REPORTER,
    agentCmd,
    promptBytes: Buffer.byteLength(prompt),
    enabled: observability,
  });

  let out: string;
  try {
    out = execFileSync(shellPath(), ['-c', agentCmd], {
      input: prompt,
      encoding: 'utf8',
      timeout: REPORTER_TIMEOUT_MS,
      // stderr goes to the terminal so a failing agent says why.
      stdio: ['pipe', 'pipe', 'inherit'],
      cwd: repoRoot,
      env,
    });
  } catch (err) {
    run.finish({ exitCode: null, output: null });
    throw err;
  }
  run.finish({ exitCode: 0, output: out });
  return out;
}

// Every flag this command reads. Anything else is a typo, and a typo used to be silently ignored —
// sometimes into a different action entirely.
const LOGOS_FLAGS = ['--raw'];
const LOGOS_USAGE = 'usage: glafka logos <ticket-id> [--raw]';

export function runLogos({
  args,
  stateDir,
  repoRoot,
  config,
  personaContent,
}: Pick<CommandContext, 'args' | 'stateDir' | 'repoRoot' | 'config' | 'personaContent'>): void {
  assertKnownFlags(args, LOGOS_FLAGS, LOGOS_USAGE);
  const id = args.find((arg) => !arg.startsWith('--'));
  if (!id) {
    throw new Error(
      'usage: glafka logos <ticket-id> [--raw]\n' +
        '       same status as `glafka poreia`, re-worded by an agent — this one costs tokens\n' +
        '       glafka poreia --all  lists the tickets you have',
    );
  }

  const { raw, prompt } = logos({ stateDir, id, repoRoot, personaContent });

  // `--raw` skips the reporter entirely. Same output as every fallback
  // below, so it is also how you check what the reporter was handed.
  const asked = !args.includes('--raw');
  const agentCmd = asked ? resolveAgentCmd({ config, role: ROLES.REPORTER }) : null;
  if (!agentCmd) {
    // Say so, the way the two failure paths below already do. The one thing that makes `logos`
    // different from the free `poreia` is the model call, and this branch used to skip it in
    // silence — so the README's own example config, which sets `coder` and `reviewer` but no
    // `reporter`, produced byte-identical output to `--raw` with nothing to explain why.
    if (asked) {
      console.error(
        `logos: no "reporter" agent is configured, so nothing was re-worded — this is ` +
          `\`poreia\`'s own report. Set "agents": { "reporter": "${EXAMPLE_AGENT_CMD}" } in .glafka.json, ` +
          `or use \`glafka poreia ${id}\`, which is the free command for exactly this.`,
      );
    }
    console.log(raw);
    return;
  }

  let rendered: string;
  try {
    rendered = renderWithAgent({
      agentCmd,
      prompt,
      repoRoot,
      stateDir,
      observability: config.observability.enabled,
    });
  } catch (err) {
    // A missing report is worse than an unpolished one. Nothing here is
    // worth failing the command over, because the facts are already in hand.
    console.error(`logos: the reporter failed (${(err as Error).message}) — printing the report`);
    console.log(raw);
    return;
  }

  if (rendered.trim() === '') {
    console.error('logos: the reporter returned nothing — printing the report');
    console.log(raw);
    return;
  }

  console.log(rendered.trimEnd());
}
