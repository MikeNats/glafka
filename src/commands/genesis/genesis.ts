import {
  writeTicket,
  readTicket,
  updateTicket,
  withTicketLock,
  recordStage,
  assertNotClosed,
  STAGES,
} from '../../ticket/ticketStore.js';
import { buildTicketId } from '../../ticket/ids.js';
import { readDoc, writeDoc } from '../../memory/docsStore.js';
import { specPath as specDocPath, ticketIdTaken } from '../../ticket/paths.js';
import { provisionTicket } from './utils.js';
import { recordHandover } from '../../audit/recordRun.js';
import { AUDIT_STAGES } from '../../audit/record.js';
import { ROLES, type Ticket } from '../../types/ticket.js';
import { assertNoDuplicateCriteria } from '../../ticket/criteria.js';

// The spec and the plan are written by whoever is at the keyboard — a person,
// or the session's own agent following the genesis skill. No process of ours
// starts, so nothing else in the audit would ever mention them, and the git
// copy showed a ticket that appeared to begin at its first coder run.
// `note` is what tells the two rows apart: the stage is `genesis` for both.
function recordSessionDraft({
  stateDir,
  id,
  note,
  content,
  observability,
}: {
  stateDir: string;
  id: string;
  note: string;
  content: string;
  observability: boolean;
}): void {
  recordHandover({
    stateDir,
    ticketId: id,
    stage: AUDIT_STAGES.GENESIS,
    // Drafting text, not writing code and not judging it. Same role the two
    // genesis draft prompts use, for the same reason.
    role: ROLES.REPORTER,
    promptBytes: Buffer.byteLength(content),
    note,
    enabled: observability,
  });
}

// The name for a new ticket, or a refusal saying why. Both entry points below
// mint an id this way, so a ticket is named the same however it was opened.
function mintTicketId({
  stateDir,
  repoRoot,
  content,
  name,
}: {
  stateDir: string;
  repoRoot: string;
  content: string;
  name: string | null;
}): string {
  const id = buildTicketId(name ?? content);
  if (!id) {
    throw new Error(
      `cannot make a name out of ${JSON.stringify(name ?? content)} — it has no a-z or ` +
        `0-9 to use. Name it yourself with --name, for example: --name "fix the login".`,
    );
  }
  const taken = ticketIdTaken({ stateDir, repoRoot, id });
  if (taken) {
    throw new Error(
      `${id} already exists (${taken}). Word the idea differently. A closed or cancelled ticket keeps its name.`,
    );
  }
  return id;
}

// Opens a ticket in one go: sets everything up, then writes the file.
// This is the old path, and heureka still uses it.
export async function genesis({
  repoRoot,
  stateDir,
  content,
  name = null,
  baseRef = 'main',
  planContent = null,
  portRange = undefined,
  bootstrapTimeoutMs = undefined,
  isolationHookTimeoutMs = undefined,
  checksCmd = null,
  checksTimeoutMs = null,
}: {
  repoRoot: string;
  stateDir: string;
  content: string;
  // Names the ticket when the idea itself has nothing to slug.
  name?: string | null;
  baseRef?: string;
  planContent?: string | null;
  portRange?: { start: number; end: number };
  bootstrapTimeoutMs?: number;
  isolationHookTimeoutMs?: number;
  // Passed to the checks baseline. See src/checksBaseline.ts.
  checksCmd?: string | null;
  checksTimeoutMs?: number | null;
}): Promise<Ticket> {
  assertNoDuplicateCriteria(content, 'the ticket text');
  const id = mintTicketId({ stateDir, repoRoot, content, name });
  return provisionTicket({
    repoRoot,
    stateDir,
    id,
    title: null,
    content,
    created: new Date().toISOString(),
    stage: STAGES.GENESIS,
    baseRef,
    planContent,
    portRange,
    bootstrapTimeoutMs,
    isolationHookTimeoutMs,
    checksCmd,
    checksTimeoutMs,
  });
}

// -------------------------------------------------------------------------- The step-by-step flow: create, then spec, then plan.

// It does not wait for anything: no worktree, no port, no network yet.
export function createTicket({
  stateDir,
  repoRoot,
  content,
  name = null,
}: {
  stateDir: string;
  repoRoot: string;
  content: string;
  // Names the ticket when the idea itself has nothing to slug.
  name?: string | null;
}): Ticket {
  assertNoDuplicateCriteria(content, 'the ticket text');
  const id = mintTicketId({ stateDir, repoRoot, content, name });
  const now = new Date().toISOString();
  // Locked — matches every other ticket write. The
  // name was free a moment ago; the lock is what makes that hold.
  withTicketLock(stateDir, id, () => {
    writeTicket(stateDir, {
      id,
      title: null,
      branch: null,
      worktree: null,
      specText: content,
      specPath: null,
      planPath: null,
      port: null,
      isolationPorts: null,
      planCommit: null,
      created: now,
      updated: now,
      guardrails: null,
    });
  });
  recordStage(stateDir, id, STAGES.CREATE);
  return readTicket(stateDir, id);
}

// Writes the spec before anything is set up, and can be rerun until then.
// Once a worktree exists it refuses, or the code and spec would disagree.
export function attachSpec({
  stateDir,
  repoRoot,
  id,
  specPath: givenPath,
  title = null,
  observability = false,
}: {
  stateDir: string;
  repoRoot: string;
  id: string;
  specPath: string;
  title?: string | null;
  observability?: boolean;
}): Ticket {
  const ticket = readTicket(stateDir, id);
  assertNotClosed(ticket);
  if (ticket.worktree) {
    throw new Error(
      `ticket ${id} already has a worktree — its spec is locked in; ` +
        `this only works before plan has run`,
    );
  }

  const content = readDoc(givenPath);

  assertNoDuplicateCriteria(content, givenPath);

  // Named after the id, so a re-run under a new title overwrites one file
  // rather than leaving the old name beside the new one.
  const canonicalPath = specDocPath(repoRoot, id);
  writeDoc(canonicalPath, content);

  // Locked read-modify-write — reads the current ticket again under the lock, so a concurrent write in between is never
  updateTicket(stateDir, id, (current) => ({
    specPath: canonicalPath,
    specText: content,
    title: title ?? current.title,
  }));
  recordStage(stateDir, id, STAGES.SPEC);
  recordSessionDraft({ stateDir, id, note: 'spec', content, observability });
  return readTicket(stateDir, id);
}

// Any file at all used to be accepted here, including an empty one, and a ticket got a worktree, a
// branch and ports before anyone noticed.
export function assertUsablePlan(content: string, sourcePath: string): void {
  if (content.trim() === '') {
    throw new Error(
      `${sourcePath} is empty — a plan is what the coder works from, so there is nothing to provision for.`,
    );
  }
  // A warning, not a refusal. The shape is asked for in buildPlanPrompt and in
  // genesis.md; a terse plan someone meant is still theirs to approve.
  const hasSteps = /^\s*-\s*\[[ xX]\]/m.test(content);
  const hasTasks = /^##\s+Task\b/m.test(content);
  if (hasSteps && hasTasks) return;
  const missing = [!hasTasks && '`## Task N` heading', !hasSteps && '`- [ ]` step'].filter(Boolean);
  console.error(
    `note: ${sourcePath} has no ${missing.join(' and no ')} — progress on it cannot be tracked.`,
  );
  console.error(
    `      See the shape \`glafka genesis --plan-draft\` asks for. Provisioning anyway.`,
  );
}

// Sets up a step-by-step ticket. The same work as genesis(),
// but on an id that already exists.
export async function attachPlan({
  stateDir,
  repoRoot,
  id,
  planPath: givenPath,
  baseRef = 'main',
  portRange = undefined,
  bootstrapTimeoutMs = undefined,
  isolationHookTimeoutMs = undefined,
  checksCmd = null,
  checksTimeoutMs = null,
  observability = false,
}: {
  stateDir: string;
  repoRoot: string;
  id: string;
  planPath: string;
  observability?: boolean;
  baseRef?: string;
  portRange?: { start: number; end: number };
  bootstrapTimeoutMs?: number;
  isolationHookTimeoutMs?: number;
  // Passed to the checks baseline. See src/checksBaseline.ts.
  checksCmd?: string | null;
  checksTimeoutMs?: number | null;
}): Promise<Ticket> {
  const ticket = readTicket(stateDir, id);
  assertNotClosed(ticket);
  if (ticket.worktree) {
    throw new Error(`ticket ${id} already has a worktree — plan already ran`);
  }
  if (!ticket.specPath) {
    throw new Error(`ticket ${id} has no spec yet — run spec before plan`);
  }

  const planContent = readDoc(givenPath);
  assertUsablePlan(planContent, givenPath);
  // Before provisioning, so a plan that dies partway through still leaves
  // the trace of a plan having been written.
  recordSessionDraft({ stateDir, id, note: 'plan', content: planContent, observability });
  return provisionTicket({
    repoRoot,
    stateDir,
    id,
    title: ticket.title,
    content: ticket.specText,
    created: ticket.created,
    stage: STAGES.PLAN,
    baseRef,
    planContent,
    portRange,
    bootstrapTimeoutMs,
    isolationHookTimeoutMs,
    checksCmd,
    checksTimeoutMs,
  });
}

export { buildSpecPrompt, buildPlanPrompt } from './prompts.js';
