import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolvePolicy } from './resolve.js';
import type { CurrentPin, TicketGuardrailsPin } from './types/pin.js';

// Ties the policy to the ticket. We save a fingerprint when a ticket opens
// and check it later, so a change part way through is caught.

// The hook config files. Their content is part of the fingerprint, so an
// edit here is caught too. Kimi's config is global, so it is left out.
export const HOOK_CONFIG_PATHS = [
  '.claude/settings.json',
  '.gemini/settings.json',
  '.cursor/hooks.json',
  '.opencode/plugin/glafka-guardrails.js',
  '.github/hooks/glafka-guardrails.json',
];

// Hook configs are read by every harness from ITS OWN cwd, which for a spawned coder is the ticket's worktree, not repoRoot — and
function hookConfigsHash(root: string): string {
  const h = crypto.createHash('sha256');
  for (const rel of HOOK_CONFIG_PATHS) {
    const filePath = path.join(root, rel);
    h.update(rel).update('\0');
    h.update(fs.existsSync(filePath) ? fs.readFileSync(filePath) : '');
    h.update('\0');
  }
  return h.digest('hex').slice(0, 16);
}

export function currentPin({
  repoRoot,
  worktree = null,
}: {
  repoRoot: string;
  worktree?: string | null;
}): CurrentPin {
  const { policy, hash, level, widened } = resolvePolicy({ repoRoot });
  return {
    level,
    hash: `${hash}-${hookConfigsHash(worktree ?? repoRoot)}`,
    name: policy.name,
    widened,
  };
}

// Called when a ticket is created. This is saved on the ticket.
// The list of loosened rules travels with it, so it stays visible.
export function pinFor({
  repoRoot,
  worktree = null,
  now,
}: {
  repoRoot: string;
  worktree?: string | null;
  now: string;
}): TicketGuardrailsPin {
  const { level, hash, name, widened } = currentPin({ repoRoot, worktree });
  return { level, name, hash, widened, pinnedAt: now };
}

interface PinnedTicket {
  id: string;
  guardrails: TicketGuardrailsPin | null;
  worktree: string | null;
}

// Called before anything that runs the agent or ships its work.
// It never updates itself, because that would defeat the point.
export function assertUnchanged({
  repoRoot,
  ticket,
  action,
}: {
  repoRoot: string;
  ticket: PinnedTicket;
  action: string;
}):
  | { checked: false; reason: string }
  | { checked: true; pinned: TicketGuardrailsPin; now: CurrentPin } {
  const pinned = ticket.guardrails;

  // Old tickets have nothing to compare. Say so, do not refuse.
  if (!pinned?.hash) return { checked: false, reason: 'ticket has no pin (opened before pinning)' };

  const now = currentPin({ repoRoot, worktree: ticket.worktree });
  if (now.hash === pinned.hash) return { checked: true, pinned, now };

  const levelMoved =
    now.level === pinned.level
      ? `still level ${now.level}, but the settings changed`
      : `level ${pinned.level} (${pinned.name}) → level ${now.level} (${now.name})`;

  throw new Error(
    `ticket ${ticket.id}: the guardrails policy changed since this ticket opened — ${levelMoved}\n` +
      `  pinned ${pinned.hash} at ${pinned.pinnedAt}\n` +
      `  now    ${now.hash}\n` +
      `  refusing to ${action} until you have looked at the change:\n` +
      `    git diff -- docs/glafka/guardrails.json\n` +
      `  then accept it:  glafka guardrails --repin ${ticket.id}`,
  );
}

// You accepting the change on purpose. Returns the new value to save.
export function repin({
  repoRoot,
  ticket,
  now,
}: {
  repoRoot: string;
  ticket: PinnedTicket;
  now: string;
}): { was: TicketGuardrailsPin | null; next: TicketGuardrailsPin } {
  const next = pinFor({ repoRoot, worktree: ticket.worktree, now });
  return { was: ticket.guardrails ?? null, next };
}
