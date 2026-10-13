// -------------------------------------------------------------------------- Prompt builders

// The plan says what we MEANT to build.
// This prompt updates it to match what was really built.
export function buildDocSyncPrompt({
  ticketId,
  // The path only. The plan used to be pasted here in full, which on a real ticket is most of this
  // prompt — and paid twice, because the agent has to open the file anyway to edit it in place.
  planPath,
  // What was ASKED for, where the plan is what we said we would do about it. Read-only here: it
  // tells the agent whether scope grew or shrank, which the plan alone cannot. Null on tickets
  // that never had one — heureka and vima both produce those.
  specPath = null,
  diff,
  // Null when this runs BEFORE the push, which is the normal case now — there
  // is no PR to name yet, and claiming one would be a link to nowhere.
  prUrl = null,
}: {
  ticketId: string;
  planPath: string | null;
  specPath?: string | null;
  diff: string;
  prUrl?: string | null;
}): string {
  // Already fenced by `boundedDiff` when there is a diff to fence — past its size ceiling the block
  // is instructions for reading the diff, not the diff, and fencing those would mislabel them.
  const diffBlock = diff.trim() === '' ? '(no diff against base)' : diff;
  const sections = [
    `Ticket ${ticketId} is about to be pushed${prUrl ? `: ${prUrl}` : ''}. Your edit will be
committed onto its branch and travel with the pull request, so write it as
part of this ticket's work.

## The documents
${docsBlock(planPath, specPath)}

## What was actually built
${diffBlock}

## Your job
Compare the plan against the diff. If anything changed from the plan — a
step skipped, an approach that changed mid-implementation, scope that
grew or shrank — update the plan document at the path above to reflect
reality. Append a
"## Result" section noting what actually shipped, and why, if it diverged.
If the plan matches what was built exactly, say so and change nothing.

## Scope — read this before you edit
Edit ONLY what this diff makes wrong. A sentence that is still accurate
stays exactly as it is, word for word. Do not reword, reorder, retitle or
tidy anything you are not correcting. The plan document is the ONLY file
you edit: not the spec, not source, not the architecture docs — another
agent owns those. "Nothing to change" is a correct and common answer — say
it and stop. You are not here to improve the document.

This file is permanent project memory — keep it honest for whoever reads
it next.`,
  ];

  // No ethos capture here. Doc sync runs unattended, so there is nobody whose
  // words it could be recording.

  return sections.join('\n\n') + '\n';
}

// Paths, not contents. Says which one is editable, because the prompt now names two documents and
// only one of them is this agent's to change.
function docsBlock(planPath: string | null, specPath: string | null): string {
  const lines = [
    planPath
      ? `- The plan, and the file you edit: ${planPath}`
      : '- The plan: path unknown — say so and stop, there is nothing here to edit.',
  ];
  if (specPath) lines.push(`- What was asked for, read-only: ${specPath}`);
  lines.push(
    '',
    'Open and read them. They are not pasted here: the plan is the file you are',
    'about to edit, so pasting it would only mean reading it twice.',
  );
  return lines.join('\n');
}
