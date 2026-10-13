import fs from 'node:fs';
import path from 'node:path';

// Ties an agent SESSION to a ticket, so a coder running inside your own session can be caged.
// The problem this solves: `evaluateActions` answers "which ticket is this?" from
// the cwd, `GLAFKA_TICKET_ID`, or a file path. On the documented primary flow — an in-session
// subagent — all three miss. The cwd is your session's, the env var is only set by
// `spawnBackground`, and a Bash action has no file path. With no ticket, every layer is skipped.
// Why a session id and not a process group: a subagent's tool calls and your own tool calls come
// from the same process tree, so ancestry cannot tell them apart. The harness CAN: it issues a
// distinct session id per subagent, and sends it on every hook payload. That is the one signal that
// separates "the coder working the ticket" from "you, in your own checkout" — which is the
// distinction this must not get wrong in the loose direction. How the marker gets written: the
// coder is told, as its first instruction, to run `glafka guardrails --claim <ticket-id>`. That
// runs as a tool call, so it arrives at the hook — the only place that sees BOTH the session id and
// the ticket id. The hook records the pair and lets the command through.

const SESSIONS_DIR = 'sessions';

// A session id comes from the harness, and it reaches a file path, so it is
// checked the same way a ticket id is rather than trusted.
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isValidSessionId(sessionId: string): boolean {
  return SESSION_ID_RE.test(sessionId) && !sessionId.includes('..');
}

function sessionFile(stateDir: string, sessionId: string): string | null {
  if (!isValidSessionId(sessionId)) return null;
  return path.join(stateDir, SESSIONS_DIR, sessionId);
}

// The command a coder runs to say "every tool call from this session belongs to this ticket".
// ANCHORED at both ends, on purpose. A claim is read before the session is attributed, so it is the
// one command seen while nothing is known about the caller. If this matched a claim ANYWHERE in the
// string, then `glafka guardrails --claim t-x; rm -rf ~` would be read as a claim, and whatever
// else rode along on that line would be waved through with it. One command, nothing before it,
// nothing after it — anything else is not a claim and gets checked like any other command. A
// leading `node .glafka/bin/glafka.js` form is accepted because that is how skills/ergon.md tells a
// coder to invoke glafka.
const CLAIM_RE =
  /^\s*(?:glafka|node\s+\S*glafka(?:\.js)?)\s+guardrails\s+--claim\s+([A-Za-z0-9_-]+)\s*$/;

// The ticket id a command is claiming, or null when it is not a claim at all.
export function claimedTicketId(commandString: string | null | undefined): string | null {
  if (!commandString) return null;
  return CLAIM_RE.exec(commandString)?.[1] ?? null;
}

// Records session → ticket. Returns false when the pair cannot be stored,
// which the caller must not treat as a claim having happened.
export function recordSessionClaim({
  stateDir,
  sessionId,
  ticketId,
}: {
  stateDir: string;
  sessionId: string;
  ticketId: string;
}): boolean {
  const file = sessionFile(stateDir, sessionId);
  if (file === null) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ ticketId, at: new Date().toISOString() })}\n`);
    return true;
  } catch {
    return false;
  }
}

// The ticket this session claimed, or null. Null is the ordinary answer for YOUR session — the hook
// is installed repo-wide, so it fires on your own tool calls too, and they must keep working.
export function sessionTicketId({
  stateDir,
  sessionId,
}: {
  stateDir: string;
  sessionId: string | null | undefined;
}): string | null {
  if (!sessionId) return null;
  const file = sessionFile(stateDir, sessionId);
  if (file === null) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { ticketId?: unknown };
    return typeof parsed.ticketId === 'string' ? parsed.ticketId : null;
  } catch {
    return null;
  }
}

// Was a claim for this ticket recorded just now? The `--claim` command cannot check its own session
// directly: the session id only ever exists in the hook payload, never in the environment of the
// command the hook is checking. What it CAN do is look for the marker the hook should have just
// written. A claim recorded seconds ago is the hook confirming it saw this call; nothing there
// means the hook never ran, which is precisely the state where the coder is uncaged and needs to be
// told.
export function claimRecordedRecently({
  stateDir,
  ticketId,
  withinMs = 60_000,
}: {
  stateDir: string;
  ticketId: string;
  withinMs?: number;
}): boolean {
  const dir = path.join(stateDir, SESSIONS_DIR);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return false;
  }
  const cutoff = Date.now() - withinMs;
  for (const name of entries) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as {
        ticketId?: unknown;
        at?: unknown;
      };
      if (parsed.ticketId !== ticketId) continue;
      if (typeof parsed.at !== 'string') continue;
      if (Date.parse(parsed.at) >= cutoff) return true;
    } catch {
      // Unreadable marker. It proves nothing either way.
    }
  }
  return false;
}

// Drops a session's claim. Used when a ticket closes, so a session id the
// harness later reuses cannot inherit a cage for work that is over.
export function clearSessionClaims({
  stateDir,
  ticketId,
}: {
  stateDir: string;
  ticketId: string;
}): number {
  const dir = path.join(stateDir, SESSIONS_DIR);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  let cleared = 0;
  for (const name of entries) {
    if (sessionTicketId({ stateDir, sessionId: name }) !== ticketId) continue;
    try {
      fs.unlinkSync(path.join(dir, name));
      cleared += 1;
    } catch {
      // Another sweep got there first. Nothing to repair.
    }
  }
  return cleared;
}
