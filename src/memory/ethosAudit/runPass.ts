import { execFileSync } from 'node:child_process';
import { AUDIT_STAGES } from '../../audit/record.js';
import { ROLES } from '../../types/ticket.js';
import { shellPath } from '../../util/shell.js';
import { resolveAgentCmd } from '../../config.js';
import { resolvePolicy, buildEnv } from '../../../installKit/guardrails/index.js';
import { startRun } from '../../audit/recordRun.js';
import {
  rulesInForce,
  deadReferences,
  auditFileList,
  buildAuditPrompt,
  parseAuditResponse,
  writeAuditProposals,
  type AuditProposal,
} from './ethosAudit.js';

// An audit reads a list of one-line rules; it should not take a minute.
const AUDIT_TIMEOUT_MS = 60 * 1000;

// Why the pass produced nothing. Each caller prints its own words for these.
export type AuditPassSkip = 'no-rules' | 'no-agent' | 'agent-failed';

export interface AuditPassResult {
  ran: boolean;
  proposals: AuditProposal[];
  skip: AuditPassSkip | null;
  // The prompt, so a caller with no agent can print it for a person to paste.
  prompt: string | null;
  // Rule count at the time of the pass. The watermark is written from this.
  ruleCount: number;
  detail: string | null;
}

// One compaction pass. Read-only: it writes audit.proposed.json and nothing
// else. Never throws, so a push cannot fail over a compaction.
export function runAuditPass({
  repoRoot,
  config,
  stateDir = null,
  observability = true,
}: {
  repoRoot: string;
  config: Parameters<typeof resolveAgentCmd>[0]['config'];
  stateDir?: string | null;
  observability?: boolean;
}): AuditPassResult {
  const rules = rulesInForce(repoRoot);
  const base = { ran: false, proposals: [], prompt: null, ruleCount: rules.length, detail: null };
  if (rules.length === 0) return { ...base, skip: 'no-rules' };

  const prompt = buildAuditPrompt(rules, deadReferences(rules, auditFileList(repoRoot)));

  const agentCmd = resolveAgentCmd({ config, role: ROLES.REPORTER });
  // No agent configured is the normal documented setup, not a failure. The
  // prompt goes back so odysse can print it, the way it does today.
  if (!agentCmd) return { ...base, skip: 'no-agent', prompt };

  const { policy } = resolvePolicy({ repoRoot });
  const { env } = buildEnv(policy, process.env, {});

  // A repo-level pass, so no ticket id — it still costs money.
  const run = startRun({
    stateDir,
    ticketId: null,
    stage: AUDIT_STAGES.ODYSSE,
    role: ROLES.REPORTER,
    agentCmd,
    promptBytes: Buffer.byteLength(prompt),
    enabled: observability,
  });

  let raw: string;
  try {
    raw = execFileSync(shellPath(), ['-c', agentCmd], {
      input: prompt,
      encoding: 'utf8',
      timeout: AUDIT_TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'inherit'],
      cwd: repoRoot,
      env,
    });
  } catch (err) {
    run.finish({ exitCode: null, output: null });
    return { ...base, skip: 'agent-failed', prompt, detail: (err as Error).message };
  }
  run.finish({ exitCode: 0, output: raw });

  const proposals = parseAuditResponse(raw, rules);
  // Only write when there is something to decide. An empty file on disk would
  // read as "a pass ran" to the pending check at the push site.
  if (proposals.length > 0) writeAuditProposals(repoRoot, proposals);
  return { ran: true, proposals, skip: null, prompt, ruleCount: rules.length, detail: null };
}
