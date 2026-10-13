import type { Policy } from '../../guardrails/types/policy.js';
import type { BackgroundGuardrailsInfo } from '../../../src/ticket/background.js';
import { resolvePolicy } from '../../guardrails/index.js';
import { installedProjectHooks } from '../hooks/install.js';

// Prints which guardrails were used when the agent starts.
// It warns loudly if a cage was asked for and did not happen.
export function reportGuardrails(
  policy: Policy | null,
  guardrails: BackgroundGuardrailsInfo,
  widened: string[] = [],
): void {
  if (!policy || policy.level === 0) return;
  const bits = [`guardrails level ${policy.level} (${policy.name})`];
  if (policy.sandbox.enabled) {
    bits.push(
      guardrails.failed ? `NOT SANDBOXED — ${guardrails.note}` : `sandbox: ${guardrails.backend}`,
    );
  }
  if (guardrails.droppedEnv) bits.push(`${guardrails.droppedEnv} env var(s) dropped`);
  console.log(bits.join('  ·  '));
  for (const warning of guardrails.warnings ?? []) console.log(`  warning: ${warning}`);
  if (widened.length > 0) console.log(`  ⚠ this project loosened: ${widened.join(', ')}`);
}

// Says what a coder on this ticket will and will not be held to, at the START of a ticket. It used to
// come out at the coder's first tool call — after a brainstorm, a plan, an approval and a worktree.
//
// On stderr, never stdout. Callers parse an id or a branch off stdout, and
// advice is not data. Never blocks: what an agent may do is the project's call.
export function warnGuardrailsNotReady({
  repoRoot,
  baseRef,
}: {
  repoRoot: string;
  baseRef: string;
}): void {
  let level: number;
  let projectFile: string | null;
  try {
    ({ level, projectFile } = resolvePolicy({ repoRoot }));
  } catch {
    // A policy that will not parse already fails loudly wherever it is
    // enforced. It must not turn `create` into a failure too.
    return;
  }

  // Nobody has decided anything. Say so once, here, while it is still cheap.
  if (!projectFile) {
    console.error(`note: guardrails are off (level 0) — the coder will run uncaged.`);
    console.error(
      `      To change that, on ${baseRef}: \`glafka guardrails --level 2\` then ` +
        `\`glafka guardrails --install-hook\` (needs a fresh agent session).`,
    );
    return;
  }

  if (level === 0) return;

  // Enforcement was asked for. Without a hook it silently does not happen,
  // which is worse than never asking, so this one is a warning.
  const installed = installedProjectHooks(repoRoot);
  if (installed.length > 0) return;
  console.error(
    `⚠ guardrails are set to level ${level}, but no hook is installed in this project.`,
  );
  console.error(`  Nothing will be enforced. On ${baseRef}: \`glafka guardrails --install-hook\``);
  console.error(`  (needs a fresh agent session before it takes effect).`);
}
