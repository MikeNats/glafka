import fs from 'node:fs';
import path from 'node:path';

import { resolvePolicy, scopesFor } from './resolve.js';
import { decide } from './enforce.js';
import {
  toArgvSegments,
  REDIRECTION_UNREADABLE,
  ENV_PREFIX_UNREADABLE,
} from './layers/shellwords.js';
import * as audit from './audit.js';
import { claimedTicketId, recordSessionClaim, sessionTicketId } from './session.js';
// Deliberate edge: one private function, ticketExists, needs these path helpers.
// A known, accepted back-edge: removing it costs more than it is worth.
import { ticketFiles, ticketsDir, closedTicketsDir } from '../../src/ticket/paths.js';
import type { Policy } from './types/policy.js';
import type { Action, UnreadableExecAction } from './types/action.js';
import type { Decision } from './types/decision.js';

// Shared logic used by every hook adapter.

// The file's text with spaces trimmed, or null if we can not read it.
function readTrimmed(target: string): string | null {
  try {
    return fs.readFileSync(target, 'utf8').trim();
  } catch {
    return null;
  }
}

// The real path if the file exists, otherwise the plain full path.
function realish(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

// A worktree's ".git" is a file the agent can write, and it decides which rules apply. So we do not trust it alone: it must point at a folder that
function resolveWorktreePointer(worktreeDir: string, gitPath: string): string {
  const gitdirLine = fs.readFileSync(gitPath, 'utf8').trim();
  const worktreeGitDir = path.resolve(worktreeDir, gitdirLine.replace(/^gitdir:\s*/, ''));

  // Git writes the real path here, so we compare real paths. On macOS,
  // /var and /private/var are the same folder but look different.
  const backPointer = readTrimmed(path.join(worktreeGitDir, 'gitdir'));
  if (backPointer === null || realish(backPointer) !== realish(gitPath)) {
    throw new Error(
      `${gitPath} points at ${worktreeGitDir}, which does not point back at it — refusing to trust it`,
    );
  }

  const commondirLine = readTrimmed(path.join(worktreeGitDir, 'commondir'));
  if (commondirLine === null) {
    throw new Error(
      `${worktreeGitDir} has no commondir file, so it is not a worktree git made — refusing to trust it`,
    );
  }
  const commonDir = path.resolve(worktreeGitDir, commondirLine);
  if (realish(path.dirname(worktreeGitDir)) !== realish(path.join(commonDir, 'worktrees'))) {
    throw new Error(
      `${worktreeGitDir} is not registered under ${commonDir}/worktrees — refusing to trust it`,
    );
  }

  return path.dirname(commonDir);
}

// Finds the main repo root, even from a worktree.
// It never runs git, because that is too slow to do on every call.
export function findRepoRoot(cwd?: string): string {
  let dir = path.resolve(cwd ?? process.cwd());
  while (true) {
    const gitPath = path.join(dir, '.git');
    if (fs.existsSync(gitPath)) {
      if (fs.statSync(gitPath).isDirectory()) return dir;
      return resolveWorktreePointer(dir, gitPath);
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`not a git repository (or any parent): ${cwd}`);
    dir = parent;
  }
}

// The folder after ".worktrees" is the ticket id. We look at the raw path
// first, so an attempt to break out is still spotted.
export function ticketIdFrom(input: string): string | null {
  const raw = input.split(path.sep);
  const rawIdx = raw.lastIndexOf('.worktrees');
  if (rawIdx !== -1 && raw[rawIdx + 1]) return raw[rawIdx + 1];

  const parts = path.resolve(input).split(path.sep);
  const i = parts.lastIndexOf('.worktrees');
  return i !== -1 && parts[i + 1] ? parts[i + 1] : null;
}

// Splits a shell line like `a && b` into separate commands to check.
export function expandExec(
  action: Action,
  policy: Pick<Policy, 'exec'>,
): (Action | UnreadableExecAction)[] {
  const commandString = 'commandString' in action ? action.commandString : undefined;
  if (action.op !== 'exec' || commandString == null) return [action];

  const result = toArgvSegments(commandString);
  if ('unreadable' in result) {
    if (!policy.exec.enabled) return [action];
    const unreadable = result.unreadable ?? 'unreadable';
    // allowShellStrings (level 2) falls back to a coarse "does this string mention a never-listed
    // command" scan — a real fallback for eval/$()/ Two reasons never fall back, because the coarse
    // scan cannot see either one: a redirection names a file it does not read, and an environment
    // prefix changes what the named command does without changing its name.
    const noFallback =
      unreadable === REDIRECTION_UNREADABLE || unreadable.startsWith(ENV_PREFIX_UNREADABLE);
    if (policy.exec.allowShellStrings && !noFallback) {
      return [action];
    }
    return [{ op: 'exec', commandString, unreadable }];
  }
  return result.segments.map((argv) => ({ op: 'exec' as const, argv, from: commandString }));
}

// True if this ticket id really exists, open or closed.
function ticketExists(stateDir: string, id: string): boolean {
  try {
    const { ticketFile: activeFile } = ticketFiles(ticketsDir(stateDir), id);
    if (fs.existsSync(activeFile)) return true;
    const { ticketFile: closedFile } = ticketFiles(closedTicketsDir(stateDir), id);
    return fs.existsSync(closedFile);
  } catch {
    return false;
  }
}

// The ticket id a `--claim` command names, across every action in this call.
// A tool call can carry more than one action, and only an exec can be a claim.
function claimFrom(baseActions: Action[]): string | null {
  for (const action of baseActions) {
    if (action.op !== 'exec') continue;
    const commandString = 'commandString' in action ? action.commandString : null;
    const claimed = claimedTicketId(commandString);
    if (claimed) return claimed;
  }
  return null;
}

// The first action that has a file path. Shell actions have none.
function firstFilePath(baseActions: Action[]): string | null {
  for (const action of baseActions) {
    const filePath = 'filePath' in action ? action.filePath : undefined;
    if (filePath) return filePath;
  }
  return null;
}

export type EvaluationResult = { ok: true } | { ok: false; layer: string | null; reason: string };

// Checks every action and stops at the first one that is refused.
export function evaluateActions({
  repoRoot,
  cwd,
  baseActions,
  sessionId = null,
}: {
  repoRoot: string;
  cwd: string;
  baseActions: Action[];
  // The harness's own id for the session this call came from. Absent on
  // harnesses that do not send one, and on glafka's own internal calls.
  sessionId?: string | null;
}): EvaluationResult {
  const resolved = resolvePolicy({ repoRoot });
  const { policy } = resolved;
  const stateDir = path.join(repoRoot, '.glafka');

  // Level 0 checks nothing.
  if (policy.level === 0) return { ok: true };

  // A coder claiming a ticket for its session. Recorded here, before attribution,
  // because it is the thing that MAKES this session attributable — nothing else in the call can say
  // which ticket it belongs to. Recorded, and then checked like anything else. It does NOT return
  // early: an early return would mean the claim command skipped every layer, and `claimFrom`
  // deciding what counts as a claim would become the whole security boundary. `glafka` is on the
  // exec allow list at every level, so a real claim passes the layers on its own merits, now
  // attributed to the ticket it just named.
  const claim = claimFrom(baseActions);
  if (claim && sessionId) {
    if (!ticketExists(stateDir, claim)) {
      return {
        ok: false,
        layer: 'core',
        reason: `cannot claim "${claim}" for this session — no such ticket`,
      };
    }
    recordSessionClaim({ stateDir, sessionId, ticketId: claim });
  }

  // Try the current folder first. That covers a real child process.
  let ticketId = ticketIdFrom(cwd);
  if (!ticketId) {
    // The env var also covers agents in the same session.
    const envId = process.env.GLAFKA_TICKET_ID;
    if (envId && ticketExists(stateDir, envId)) ticketId = envId;
  }
  if (!ticketId) {
    // The session marker. This is the one that catches an in-session subagent: its cwd is yours, it
    // has no env var, and a Bash action carries no path, so before this every one of its calls fell
    // through to "allow everything". Your OWN session never claimed anything, so it
    // stays unattributed and your work is untouched.
    const claimedId = sessionTicketId({ stateDir, sessionId });
    if (claimedId && ticketExists(stateDir, claimedId)) ticketId = claimedId;
  }
  // Last try: guess from the file path, but check the id is real.
  let unresolvedEscape = false;
  if (!ticketId) {
    const filePath = firstFilePath(baseActions);
    const fallbackId = filePath ? ticketIdFrom(filePath) : null;
    if (fallbackId && ticketExists(stateDir, fallbackId)) {
      ticketId = fallbackId;
    } else if (filePath && filePath.split(path.sep).includes('.worktrees')) {
      // It names a worktree but no real ticket. Treat that as suspicious.
      unresolvedEscape = true;
    }
  }

  // No ticket usually means you, in the main checkout, not a caged coder.
  if (!ticketId) {
    if (unresolvedEscape && policy.level >= 2) {
      return {
        ok: false,
        layer: 'core',
        reason:
          'path names a ticket worktree, but no real ticket could be confirmed from it — refusing rather than guessing',
      };
    }

    // With neither sign, this is you in your own checkout. A real coder always has both, so
    // refusing here would only block your own work. But a coder running in YOUR session has neither
    // either, and then this branch is the whole cage: every layer is skipped and nothing is written
    // down. Recording it does not stop that — it makes a run with zero checks
    // visible after the fact instead of silent, which is the finding's own minimum. Nothing here is
    // a decision, so it cannot block.
    try {
      audit.record(policy, {
        stateDir,
        ticketId: null,
        action: baseActions[0] ?? { op: 'unknown' },
        decision: {
          allow: true,
          layer: 'core',
          reason:
            'unattributed — no ticket could be identified from the cwd, GLAFKA_TICKET_ID or any path, so NO layer ran',
          weak: true,
        },
      });
    } catch {
      // A failed write to the log must not change the decision.
    }
    return { ok: true };
  }

  const scopes = scopesFor({ repoRoot, ticketId });

  for (const base of baseActions) {
    for (const action of expandExec(base, policy)) {
      const decision: Decision =
        'unreadable' in action
          ? {
              allow: false,
              layer: 'exec',
              reason: `command cannot be checked: ${action.unreadable} — rewrite it as plain commands`,
            }
          : decide(policy, action, scopes, cwd);

      try {
        audit.record(policy, { stateDir, ticketId, action, decision });
      } catch {
        // A failed write to the log must not change the decision.
      }

      if (!decision.allow) {
        return { ok: false, layer: decision.layer ?? 'policy', reason: decision.reason };
      }
    }
  }

  return { ok: true };
}

// Same as evaluateActions, but it finds the repo itself
// and refuses if anything goes wrong.
export function evaluateFromCwd({
  cwd,
  baseActions,
  sessionId = null,
}: {
  cwd: string;
  baseActions: Action[];
  sessionId?: string | null;
}): EvaluationResult {
  let repoRoot: string;
  try {
    repoRoot = findRepoRoot(cwd);
  } catch (err) {
    return {
      ok: false,
      layer: null,
      reason: `guardrails: could not find the repo (${(err as Error).message}) — denying`,
    };
  }
  try {
    return evaluateActions({ repoRoot, cwd, baseActions, sessionId });
  } catch (err) {
    return {
      ok: false,
      layer: null,
      reason: `guardrails: could not load the policy (${(err as Error).message}) — denying`,
    };
  }
}
