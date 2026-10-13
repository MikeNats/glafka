import { readAudit, readAuditSummary, NO_TICKET } from '../../../src/audit/read.js';
import { renderAudit, renderSummary } from '../../../src/audit/render.js';
import { assertKnownFlags } from '../cli/args.js';
import { TICKET_ID_RE } from '../../../src/ticket/ids.js';

const AUDIT_FLAGS = ['--json'];
const AUDIT_USAGE = 'usage: glafka audit [<ticket-id>] [--json]';

// Named runAuditCommand so it can't collide with another command's own
// local run<Name> helper.
export function runAuditCommand({
  args,
  stateDir,
  repoRoot,
}: {
  args: string[];
  stateDir: string;
  repoRoot: string;
}): void {
  assertKnownFlags(args, AUDIT_FLAGS, AUDIT_USAGE);
  const ticketId = args.find((arg) => !arg.startsWith('--')) ?? null;
  const wantsJson = args.includes('--json');

  // No id means "across every ticket" — the waste question, not one
  // ticket's own no-ticket record.
  if (ticketId === null) {
    const summary = readAuditSummary({ stateDir, repoRoot });
    console.log(wantsJson ? JSON.stringify(summary, null, 2) : renderSummary(summary));
    return;
  }

  // The summary lists repo-level spend under this name, so it has to be a
  // name you can then ask about. Scans and reports belong to no ticket.
  if (ticketId === NO_TICKET) {
    const report = readAudit({ stateDir, repoRoot, ticketId: null });
    console.log(wantsJson ? JSON.stringify(report, null, 2) : renderAudit(report));
    return;
  }

  // A ticket id here is user input. Left unchecked, readAudit throws deep
  // inside on a malformed shape — a bare assertion, not an answer.
  if (!TICKET_ID_RE.test(ticketId)) {
    throw new Error(
      `audit: "${ticketId}" is not a valid ticket id — ticket ids look like ` +
        `2026-08-07-add-dark-mode\n${AUDIT_USAGE}\nglafka poreia --all lists the ones you have`,
    );
  }

  const report = readAudit({ stateDir, repoRoot, ticketId });

  // The same object either way. The table is only a rendering of it.
  console.log(wantsJson ? JSON.stringify(report, null, 2) : renderAudit(report));
}
