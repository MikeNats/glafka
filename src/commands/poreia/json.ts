import { readTicket, listTickets } from '../../ticket/ticketStore.js';
import { parseCriteria } from '../../ticket/criteria.js';
import { poreia } from './poreia.js';
import { summaryFor } from './utils.js';
import type { PoreiaView } from './utils.js';
import type { Ticket, CriterionSkip, VerifyResult, VerifyOutcome } from '../../types/ticket.js';

// One ticket as `poreia --json` prints it. Elaia, the VS Code extension, reads this.
// Renaming, removing or retyping a key breaks Elaia, so the contract test guards the keys.
export interface PoreiaJson extends PoreiaView {
  worktree: string | null;
  branch: string | null;
  specPath: string | null;
  planPath: string | null;
  created: string;
  updated: string;
  // The full stage log, oldest first.
  stages: { at: string; stage: string; note: string | null }[];
  criteria: { id: string; text: string }[];
  criteriaSkips: CriterionSkip[];
  // The current QA round. Null when no round was ever opened.
  qa: { outcome: VerifyOutcome | null; openedAt: string | null; results: VerifyResult[] } | null;
  summary: { rank: number; text: string };
}

// Copied field by field, so nothing inside (like the QA token hash) leaks out.
export function toPoreiaJson(view: PoreiaView, ticket: Ticket): PoreiaJson {
  const round = ticket.verification;
  const { status, findings, verdict, back, total } = view.review;
  return {
    ...view,
    // The status read from disk also holds the whole ticket, token hashes too.
    review: { status, findings, verdict, back, total },
    worktree: ticket.worktree,
    branch: ticket.branch,
    specPath: ticket.specPath,
    planPath: ticket.planPath,
    created: ticket.created,
    updated: ticket.updated,
    stages: ticket.stageLog.map((entry) => ({
      at: entry.at,
      stage: entry.stage,
      note: entry.note ?? null,
    })),
    criteria: parseCriteria(ticket.specText).criteria.map((c) => ({ id: c.id, text: c.text })),
    criteriaSkips: ticket.criteriaSkips.map((s) => ({ id: s.id, reason: s.reason, at: s.at })),
    qa: round
      ? {
          outcome: round.outcome,
          openedAt: round.openedAt,
          results: round.results.map((r) => ({
            id: r.id,
            result: r.result,
            evidence: r.evidence,
            at: r.at,
            verified: r.verified,
          })),
        }
      : null,
    summary: summaryFor(view),
  };
}

// One ticket by id, open or closed. Only reads, like poreia itself.
export function poreiaJson({
  stateDir,
  id,
  repoRoot = null,
  baseRef = null,
}: {
  stateDir: string;
  id: string;
  repoRoot?: string | null;
  baseRef?: string | null;
}): PoreiaJson {
  return toPoreiaJson(poreia({ stateDir, id, repoRoot, baseRef }), readTicket(stateDir, id));
}

// Every open ticket, the same set `poreia --all` shows.
export function poreiaAllJson({
  stateDir,
  repoRoot = null,
  baseRef = null,
}: {
  stateDir: string;
  repoRoot?: string | null;
  baseRef?: string | null;
}): PoreiaJson[] {
  return listTickets(stateDir).map((t) => poreiaJson({ stateDir, id: t.id, repoRoot, baseRef }));
}
