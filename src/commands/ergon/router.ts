import type { Role } from '../../types/ticket.js';
// Decides how many reviewers a diff has earned, from git facts alone. Zero tokens: it reads a file
// count and a line count, nothing else. It deliberately does NOT match paths against "risky areas".
// An earlier attempt shipped a DEFAULT_RISK_AREAS list — `**/alembic/**`, `*.prisma`, `**/auth/**`
// — which is a guess about which technologies a project uses, baked into glafka. A Python repo, a
// Rails repo and a Java repo each name those folders differently, so the list would match nothing
// and quietly send no extra reviewer. If risk areas come back, they come back the way checks did:
// `odysse` investigates the real project once, a human approves, and plain code reads the result.

// Above either of these a diff is too large for one reviewer to hold in mind at once. Both are
// starting guesses, like maxReviewRounds — set them from real tickets rather than defending the numbers.
export const LARGE_DIFF_FILES = 15;
export const LARGE_DIFF_LINES = 800;

// The most reviewers one round may ever start, whatever the diff looks like.
export const MAX_REVIEWERS = 3;

export const REVIEWER_KIND = Object.freeze({
  GENERAL: 'general',
  ARCHITECTURE: 'architecture',
});

export type ReviewerKind = (typeof REVIEWER_KIND)[keyof typeof REVIEWER_KIND];

// The first reviewer keeps the plain "reviewer" role. Everything that existed before fan-out looks
// for exactly that name, so a diff that earns only one reviewer behaves as it always did.
export const FIRST_REVIEWER_ROLE = 'reviewer';

export function roleFor(index: number): Role {
  return index === 0 ? FIRST_REVIEWER_ROLE : `${FIRST_REVIEWER_ROLE}-${index}`;
}

export interface DiffFacts {
  files: number;
  lines: number;
}

// Which kinds of reviewer this diff earns, in dispatch order. A caller that already knows the checks
// failed should not be here at all — ergonReview stops before this point, because a reviewer has nothing to add to a red diff.
export function routeReview({ files, lines }: DiffFacts): ReviewerKind[] {
  const kinds: ReviewerKind[] = [REVIEWER_KIND.GENERAL];

  if (files > LARGE_DIFF_FILES || lines > LARGE_DIFF_LINES) {
    kinds.push(REVIEWER_KIND.ARCHITECTURE);
  }

  return kinds.slice(0, MAX_REVIEWERS);
}

// Why this diff got the reviewers it did, for the human reading the output.
// One line, no LLM.
export function explainRoute({ files, lines }: DiffFacts, kinds: ReviewerKind[]): string {
  const size = `${files} file(s), ${lines} line(s)`;
  if (kinds.length === 1) return `1 reviewer — ${size}`;
  return (
    `${kinds.length} reviewers (${kinds.join(', ')}) — ${size}, ` +
    `over ${LARGE_DIFF_FILES} files or ${LARGE_DIFF_LINES} lines`
  );
}
