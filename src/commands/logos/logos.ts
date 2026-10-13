import { poreia } from '../poreia/poreia.js';
import { checksLine, verdictLine, RUN_ACTIVE } from '../poreia/utils.js';
import { UNREVIEWED_COMMIT } from '../../ticket/ticketStore.js';
import type { PoreiaView } from '../poreia/utils.js';

// λόγος — the account given. It renders what is already on disk; it decides nothing and looks
// nothing up. Two things keep this honest, and both are deliberate: 1. The raw report below is
// built with plain code, so it always exists. An LLM only ever RE-renders it. If the reporter is
// not configured, or fails, or returns nothing, you still get the full account. 2. It is never
// called from `vima` or `poreia`. Those are the zero-token paths, and a cron `vima --all` that
// quietly made one LLM call per ticket per tick is exactly the cost this project refuses.

// The facts a person needs after a ticket has moved, in plain code.
// Nothing here is a judgement — every line is a value already saved.
export function buildRawReport(view: PoreiaView): string {
  const lines = [`${view.id}  ${view.title ?? '(no title yet)'}`, ''];

  if (view.cancelled) return [...lines, 'Cancelled.'].join('\n');
  if (view.closed) {
    lines.push('Closed.');
    if (view.pushed) lines.push(`Pushed: ${view.prUrl}`);
    return lines.join('\n');
  }

  lines.push(`Position: ${view.position}`);

  // Null means this project has no app at all, and then nothing is said.
  if (view.devRunning !== null) lines.push(`App: ${view.devRunning ? 'running' : 'not running'}`);

  if (view.steps.length > 0) {
    const word = view.steps.length === 1 ? 'commit' : 'commits';
    lines.push('', `Work done (${view.steps.length} ${word}):`);
    for (const subject of view.steps) lines.push(`- ${subject}`);
  } else {
    lines.push('', 'Work done: nothing committed yet.');
  }

  if (view.progress?.uncommittedChanges) {
    lines.push('', 'There are uncommitted changes — a step may have stopped part way.');
  }

  if (RUN_ACTIVE.has(view.coder.state)) {
    lines.push('', `The coder is still running (${view.coder.state}).`);
  }

  // A coder that stopped on purpose is the one thing that outranks everything
  // below it: nothing else moves until a person answers.
  if (view.aporia) {
    lines.push('', `STOPPED ON PURPOSE — needs you.`, `Reason given: ${view.aporia.reason}`);
    return lines.join('\n');
  }

  const checks = checksLine(view.checksOutcome);
  lines.push('', `Checks: ${checks ? checks.label : 'not run yet'}`);

  if (!view.reviewRequested) {
    lines.push('Review: not requested yet.');
  } else if (RUN_ACTIVE.has(view.review.status.state)) {
    lines.push(`Review: still running (${view.review.status.state}).`);
  } else {
    const verdict = verdictLine(view.review);
    lines.push(`Review: ${verdict ? verdict.label : 'finished, no verdict recorded'}`);

    const blocking = view.review.findings.filter((f) => f.verdict === 'blocking');
    if (blocking.length > 0) {
      lines.push('', `Blocking findings (${blocking.length}):`);
      for (const f of blocking) lines.push(`- ${f.finding ?? '(no detail recorded)'}`);
    }
    if (view.unreviewedCommit) lines.push('', `After this review: ${UNREVIEWED_COMMIT}.`);
  }

  lines.push('', view.pushed ? `Pushed: ${view.prUrl}` : 'Not pushed.');

  return lines.join('\n');
}

// What the reporter is asked to do. Re-render only: it is handed the finished account and may not add
// to it, because it has no way to check anything it would add.
export function buildLogosPrompt({
  report,
  personaContent = null,
}: {
  report: string;
  personaContent?: string | null;
}): string {
  const style = personaContent
    ? `## Write it this way\n${personaContent}\n`
    : `## Write it this way\nShort. Plain words. Lead with what needs a decision.\n`;

  return `You are re-writing a finished report so it is easier to read. You are
not reviewing the work, not judging it, and not adding to it.

${style}
## Rules
- Every fact in the report below must survive. A blocking finding, a stop
  reason, a failed check: keep each one, with its detail.
- Add nothing. You cannot verify anything that is not already here.
- No preamble and no sign-off. Output the report itself, nothing else.
- Keep it under 20 lines.

## The report
${report}`;
}

// Gathers the ticket's state and builds both forms of the account.
// `raw` is what gets printed if the reporter is not configured or fails.
export function logos({
  stateDir,
  id,
  repoRoot = null,
  personaContent = null,
}: {
  stateDir: string;
  id: string;
  // Without it poreia cannot read the profile, so the app line is never shown.
  repoRoot?: string | null;
  personaContent?: string | null;
}): { view: PoreiaView; raw: string; prompt: string } {
  const view = poreia({ stateDir, id, repoRoot });
  const raw = buildRawReport(view);
  return { view, raw, prompt: buildLogosPrompt({ report: raw, personaContent }) };
}
