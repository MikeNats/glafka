import fs from 'node:fs';
import path from 'node:path';
import { writeFile, withFileLock } from '../../util/fileOperations.js';
import type { Lease } from '../../util/fileOperations.js';
import { ticketsDir, closedTicketsDir, ticketFiles, ticketLockPath } from '../paths.js';
import { TICKET_ID_RE } from '../ids.js';
import { StoredTicketSchema } from '../../types/ticket.js';
import type { Ticket, StoredTicket, StageLogEntry } from '../../types/ticket.js';

export { ticketsDir, closedTicketsDir };

// A ticket is one folder, tickets/<id>/: ticket.json holds the state, stages
// holds the history. Closed ones move to tickets/closed/<id>/.

// --------------------------------------------------------------------------- Where a ticket's two files live

// Two layouts this version cannot read: markdown tickets, and the flat
// `<id>.json` that came before one folder per ticket. Throw, do not skip.
//
// The flat one matters most. This runs on locateTicket's miss path, and
// writeTicket shares that resolver — its miss path CREATES. So a leftover
// `<id>.json` would be invisible to the new code, and the next write would
// start a fresh, empty record beside it with no error and the real history
// gone from view. Refusing loudly beats migrating machine state on the fly.
function assertNoLegacyTickets(dir: string): void {
  if (!fs.existsSync(dir)) return;
  const names = fs.readdirSync(dir);

  const markdown = names.filter((name) => name.endsWith('.md'));
  if (markdown.length > 0) {
    throw new Error(
      `${dir} holds ${markdown.length} ticket(s) in the old markdown format ` +
        `(${markdown.slice(0, 3).join(', ')}${markdown.length > 3 ? ', …' : ''}).\n` +
        `Tickets are JSON now and this version cannot read those. Finish or close ` +
        `them with the previous glafka, or delete them if they are already done.`,
    );
  }

  const flat = names.filter(
    (name) => name.endsWith('.json') && TICKET_ID_RE.test(name.slice(0, -'.json'.length)),
  );
  if (flat.length > 0) {
    throw new Error(
      `${dir} holds ${flat.length} ticket(s) in the old flat layout ` +
        `(${flat.slice(0, 3).join(', ')}${flat.length > 3 ? ', …' : ''}).\n` +
        `A ticket is one folder now — <id>/ticket.json — and this version cannot read those. ` +
        `Finish or close them with the previous glafka, or delete them if they are already done.`,
    );
  }
}

// Look in the open folder first, then the closed one.
// If it is in neither, treat it as a new ticket.
export function locateTicket(
  stateDir: string,
  id: string,
): { dir: string; ticketFile: string; stagesFile: string; recordFile: string; closed: boolean } {
  // ticketFiles checks that the id is valid (see paths.js).
  const active = ticketFiles(ticketsDir(stateDir), id);
  if (fs.existsSync(active.ticketFile)) return { ...active, closed: false };

  const closed = ticketFiles(closedTicketsDir(stateDir), id);
  if (fs.existsSync(closed.ticketFile)) return { ...closed, closed: true };

  assertNoLegacyTickets(ticketsDir(stateDir));
  return { ...active, closed: false };
}

export function ticketPath(stateDir: string, id: string): string {
  return locateTicket(stateDir, id).ticketFile;
}

// One JSON object per line. We wrote this file, so we trust its shape.
// A broken line is skipped, not thrown. Also read by stages.ts, which needs
// locateTicket from here — kept together so neither file imports the other.
export function readStageLog(stagesFile: string): StageLogEntry[] {
  if (!fs.existsSync(stagesFile)) return [];
  const entries: StageLogEntry[] = [];
  for (const line of fs.readFileSync(stagesFile, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      entries.push(JSON.parse(line) as StageLogEntry);
    } catch {
      // Bad line, skip it. The rest are still fine.
    }
  }
  return entries;
}

// --------------------------------------------------------------------------- Reading and writing

// Takes a loose type on purpose. Its job is to check a status value
// that an untyped caller could set to anything.
function assertKnownCandidates(candidates: Array<{ status?: string }>): void {
  for (const candidate of candidates) {
    const status = candidate.status ?? 'pending';
    if (!['pending', 'kept', 'discarded'].includes(status)) {
      throw new Error(
        `unknown candidate status "${candidate.status}" ` +
          `(expected one of pending, kept, discarded)`,
      );
    }
  }
}

// What writeTicket() accepts. id, created and updated are always there.
// The rest is optional, and writeTicket fills the same gaps that reading does.
export type TicketDraft = Partial<StoredTicket> & Pick<StoredTicket, 'id' | 'created' | 'updated'>;

export function writeTicket(stateDir: string, ticket: TicketDraft, lease?: Lease | null): void {
  const { ticketFile } = locateTicket(stateDir, ticket.id);
  const ethosCandidates = ticket.ethosCandidates ?? [];
  assertKnownCandidates(ethosCandidates);

  // Each field by name, not a spread. This keeps worked-out values out.
  const stored: StoredTicket = {
    id: ticket.id,
    // Just for looks. Every real check uses the id.
    title: ticket.title ?? null,
    branch: ticket.branch ?? null,
    worktree: ticket.worktree ?? null,
    prUrl: ticket.prUrl ?? null,
    specPath: ticket.specPath ?? null,
    planPath: ticket.planPath ?? null,
    port: ticket.port ?? null,
    isolationPorts: ticket.isolationPorts ?? null,
    planCommit: ticket.planCommit ?? null,
    created: ticket.created,
    updated: ticket.updated,
    specText: ticket.specText ?? '',
    ethosCandidates,
    checks: ticket.checks ?? null,
    reviewFindings: ticket.reviewFindings ?? [],
    reviewerRoles: ticket.reviewerRoles ?? [],
    // Shown to the reviewer only, never the coder. This is how we tell
    // a real reviewer from a coder approving its own work.
    reviewToken: ticket.reviewToken ?? null,
    reviewedTree: ticket.reviewedTree ?? null,
    aporia: ticket.aporia ?? null,
    notified: ticket.notified ?? false,
    // The guardrails level this ticket opened with. Null on old tickets.
    guardrails: ticket.guardrails ?? null,
    verification: ticket.verification ?? null,
    criteriaSkips: ticket.criteriaSkips ?? [],
  };
  // The lease, when the caller holds one, is checked in the last instruction before the rename — so a
  // writer whose lock was taken over refuses rather than writing second.
  writeFile(ticketFile, `${JSON.stringify(stored, null, 2)}\n`, lease);
}

// stageLog is added here, when we read, and never saved.
// One source of truth. The facts stay functions, worked out on demand.
function hydrate(stored: StoredTicket, stageLog: StageLogEntry[]): Ticket {
  return { ...stored, stageLog };
}

// Ticket ids are eight random hex characters, so mistyping one is the everyday mistake here — a
// bare ENOENT naming an internal path is not an answer to it. `code` stays 'ENOENT' because callers
// that legitimately expect a missing ticket (provisionTicket reads before it writes) branch on
// exactly that.
export class TicketNotFoundError extends Error {
  readonly code = 'ENOENT';
  constructor(stateDir: string, id: string) {
    super(
      `no ticket "${id}" — glafka poreia --all lists the tickets you have ` +
        `(closed and cancelled ones are archived under ${path.join(stateDir, 'tickets', 'closed')})`,
    );
    this.name = 'TicketNotFoundError';
  }
}

export function readTicket(stateDir: string, id: string): Ticket {
  const { ticketFile, stagesFile } = locateTicket(stateDir, id);
  let raw: string;
  try {
    raw = fs.readFileSync(ticketFile, 'utf8');
  } catch (err) {
    // Ticket ids are eight random hex characters, so mistyping one is the everyday mistake here. A bare
    // ENOENT naming an internal path is not an answer to it.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      throw new TicketNotFoundError(stateDir, id);
    throw err;
  }
  const stored = StoredTicketSchema.parse(JSON.parse(raw));
  return hydrate(stored, readStageLog(stagesFile));
}

// Moves a closed ticket's folder into tickets/closed/.
// A separate step on purpose. writeTicket never moves files itself.
export function archiveClosedTicket(stateDir: string, id: string): void {
  const from = locateTicket(stateDir, id);
  if (from.closed) return;

  const to = ticketFiles(closedTicketsDir(stateDir), id);
  fs.mkdirSync(closedTicketsDir(stateDir), { recursive: true });
  // One rename for the whole folder. The write lock is a sibling of the folder,
  // not inside it, so a holder's path still exists after this (see paths.js).
  fs.renameSync(from.dir, to.dir);

  // The run logs go with it — nothing else removed them, so every closed ticket
  // kept its megabytes. After the rename, so a failure here cannot strand it,
  // which is why this deletes from the folder's NEW home.
  // `force` covers "already gone", not "a file appeared while I was walking it" — and a run still
  // writing into this folder does exactly that, which throws ENOTEMPTY out of a close that has
  // already archived the ticket. Closing while a run finishes its last writes is ordinary, so the
  // retries buy that moment. Defensive, not proven: the flake this came from was a racy test, fixed
  // there, and a writer that outlives the retry window still throws. Nothing retries this on top.
  fs.rmSync(path.join(to.dir, 'runs'), {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}

// Every write to a ticket goes through here. The lock covers read and write,
// so two callers can not read the same old copy and undo each other.
export function updateTicket(
  stateDir: string,
  id: string,
  fn: (ticket: Ticket) => Partial<StoredTicket> | null,
): Ticket {
  // The lock sits beside the folder, not in it, so archiveClosedTicket
  // cannot move it out from under a holder.
  const lockPath = ticketLockPath(stateDir, id);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  return withFileLock(lockPath, (lease) => {
    const ticket = readTicket(stateDir, id);
    const patch = fn(ticket);
    if (patch === null) return ticket;
    const updated = { ...ticket, ...patch, updated: new Date().toISOString() };
    // Handed down so the write itself is guarded, not just wrapped by a lock
    // whose ownership might have changed while `fn` ran.
    writeTicket(stateDir, updated, lease);
    return updated;
  });
}

// Same lock `updateTicket` uses, for callers that don't fit its read-existing-ticket-then-patch shape: creating a ticket that does not
export function withTicketLock<T>(stateDir: string, id: string, fn: (lease: Lease) => T): T {
  const lockPath = ticketLockPath(stateDir, id);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  return withFileLock(lockPath, fn);
}

// --------------------------------------------------------------------------- Listing

// One broken file must not hide all the other tickets, so each file
// is read inside its own try. Reading one ticket by id still throws.
function readTicketsIn(dir: string, onUnreadable?: (warning: string) => void): Ticket[] {
  if (!fs.existsSync(dir)) return [];
  assertNoLegacyTickets(dir);
  const tickets: Ticket[] = [];
  // Filter by id validity, never by "is a directory". closed/ lives in here
  // too, and so do the `<id>.lock` and `<id>.provisioning` files — an id has
  // no dots and closed/ has no date, so none of them can match.
  for (const name of fs.readdirSync(dir).filter((n) => TICKET_ID_RE.test(n))) {
    const { ticketFile, stagesFile } = ticketFiles(dir, name);
    // No ticket.json means this folder is not a ticket, the same way a
    // directory without a `<id>.json` was simply not listed before.
    if (!fs.existsSync(ticketFile)) continue;
    try {
      const stored = StoredTicketSchema.parse(JSON.parse(fs.readFileSync(ticketFile, 'utf8')));
      tickets.push(hydrate(stored, readStageLog(stagesFile)));
    } catch (err) {
      onUnreadable?.(`skipped unreadable ticket ${ticketFile}: ${(err as Error).message}`);
    }
  }
  return tickets;
}

// Open tickets only, by default. isActive() is a safety net in case a crash
// left a closed ticket here. `onUnreadable` names each file we had to skip.
export function listTickets(
  stateDir: string,
  {
    includeClosed = false,
    onUnreadable,
  }: { includeClosed?: boolean; onUnreadable?: (warning: string) => void } = {},
): Ticket[] {
  const tickets = readTicketsIn(ticketsDir(stateDir), onUnreadable);
  if (includeClosed) tickets.push(...readTicketsIn(closedTicketsDir(stateDir), onUnreadable));

  return tickets
    .filter((ticket) => includeClosed || isActiveLocal(ticket))
    .sort((a, b) => a.created.localeCompare(b.created));
}

// isActive lives in ticketState.ts, which imports stages.ts, which imports
// store.ts — importing it here would close that loop. Same check, no import.
function isActiveLocal(ticket: Ticket): boolean {
  return !(ticket.stageLog ?? []).some((e) => e.stage === 'lysis' || e.stage === 'cancel');
}
