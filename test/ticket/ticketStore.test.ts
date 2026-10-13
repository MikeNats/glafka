import { test } from 'node:test';
import { setReviewToken } from '../../src/ticket/ticketStore.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { makeTempDir } from '../helpers/tempDir.js';
import {
  writeTicket,
  readTicket,
  listTickets,
  isActive,
  isClosed,
  hasOpenPr,
  lastRunOutcome,
  lastRunFailed,
  lastReviewOutcome,
  lastReviewFailed,
  appendReviewFinding,
  reviewFindings,
  hasBlockingFindings,
  clearReviewFindings,
  REVIEW_VERDICT,
  recordAporia,
  clearAporia,
  hasAporia,
  describeTicket,
  appendEthosCandidate,
  pendingCandidates,
  decidePendingCandidates,
  CANDIDATE_STATUS,
  CANDIDATE_SOURCE,
  recordStage,
  currentStage,
  lastStageAt,
  isReviewedSinceLastChange,
  lastStageIndex,
  archiveClosedTicket,
  readCachedChecks,
  saveCachedChecks,
  STAGES,
  RUN_OUTCOMES,
  isCancelled,
  updateTicket,
  withTicketLock,
} from '../../src/ticket/ticketStore.js';
import type { TicketDraft } from '../../src/ticket/ticketStore.js';
import {
  ticketFiles,
  ticketsDir,
  ticketLockPath,
  writeProvisioningLock,
} from '../../src/ticket/paths.js';
import { DEFAULT_CATEGORIES, targetOf } from '../../src/memory/categories.js';
import { NODE_TSX_ARGS } from '../helpers/tsxLoader.js';
import { StoredTicketSchema } from '../../src/types/ticket.js';
import type { Ticket, Stage, StageLogEntry } from '../../src/types/ticket.js';

// The default categories, in the old shape, so these tests stay easy to read.
// The real source of truth is now categories.json.
const T = Object.fromEntries(DEFAULT_CATEGORIES.map((c) => [c.name, targetOf(c)]));

function tempStateDir() {
  return makeTempDir('test');
}

// Fills in the same defaults that reading and writing do,
// so this is a real Ticket with every field, not a cut-down copy.
function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  const now = '2026-07-24T00:00:00.000Z';
  const { stageLog = [], ...rest } = overrides;
  const stored = StoredTicketSchema.parse({
    id: '2026-08-03-a-stored-ticket',
    branch: 'glafka/2026-08-03-a-stored-ticket',
    worktree: '/tmp/wt-t-00000001',
    specText: 'fix the thing',
    created: now,
    updated: now,
    ...rest,
  });
  return { ...stored, stageLog };
}

test('writeTicket then readTicket round-trips all fields', () => {
  const stateDir = tempStateDir();
  const ticket = makeTicket();

  writeTicket(stateDir, ticket);
  const loaded = readTicket(stateDir, ticket.id);

  assert.equal(loaded.id, ticket.id);
  assert.equal(loaded.branch!, ticket.branch!);
  // This is the field hasOpenPr() reads. It shows what we really save,
  // and what we only work out later.
  assert.equal(loaded.prUrl, null);
  assert.equal(hasOpenPr(loaded), false);
  assert.equal(loaded.worktree!, ticket.worktree!);
  assert.equal(loaded.specText, ticket.specText);
});

test('writeTicket then readTicket round-trips specPath and planPath', () => {
  const stateDir = tempStateDir();
  const ticket = makeTicket({
    specPath: 'docs/glafka/tickets/2026-08-07-add-dark-mode/spec.md',
    planPath: 'docs/glafka/tickets/2026-08-07-add-dark-mode/plan.md',
  });

  writeTicket(stateDir, ticket);
  const loaded = readTicket(stateDir, ticket.id);

  assert.equal(loaded.specPath, 'docs/glafka/tickets/2026-08-07-add-dark-mode/spec.md');
  assert.equal(loaded.planPath, 'docs/glafka/tickets/2026-08-07-add-dark-mode/plan.md');
});

test('specPath and planPath default to null when not given', () => {
  const stateDir = tempStateDir();
  writeTicket(stateDir, makeTicket());

  const loaded = readTicket(stateDir, '2026-08-03-a-stored-ticket');

  assert.equal(loaded.specPath, null);
  assert.equal(loaded.planPath, null);
});

// Old markdown tickets. Skipping them quietly is the danger: we would say
// "no open tickets" and then give away a port that is already in use.
test('a leftover markdown ticket is refused loudly, not silently ignored', () => {
  const stateDir = tempStateDir();
  const dir = path.join(stateDir, 'tickets');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, '2026-08-03-a-leftover-markdown-ticket.md'),
    '---\nid: "2026-08-03-a-leftover-markdown-ticket"\n---\n',
  );

  assert.throws(
    () => readTicket(stateDir, '2026-08-03-a-leftover-markdown-ticket'),
    /old markdown format/,
  );
  assert.throws(() => listTickets(stateDir), /old markdown format/);
});

// The stage log is its own file that we only add to.
// The old way read and rewrote it, so one of two writers lost its entry.
test('two stage records written without re-reading in between both survive', () => {
  const stateDir = tempStateDir();
  writeTicket(stateDir, makeTicket());

  // No read in between. This is the exact order that used to lose an entry.
  recordStage(stateDir, '2026-08-03-a-stored-ticket', STAGES.ERGON);
  recordStage(stateDir, '2026-08-03-a-stored-ticket', STAGES.REVIEW);

  assert.deepEqual(
    readTicket(stateDir, '2026-08-03-a-stored-ticket').stageLog.map((e) => e.stage),
    ['ergon', 'review'],
  );
});

// A process killed mid-write leaves half a last line. Losing that one entry
// is fine. Never being able to load the ticket again is not.
test('a torn final line in the stage log is skipped, not thrown on', () => {
  const stateDir = tempStateDir();
  writeTicket(stateDir, makeTicket());
  recordStage(stateDir, '2026-08-03-a-stored-ticket', STAGES.ERGON);
  fs.appendFileSync(
    ticketFiles(ticketsDir(stateDir), '2026-08-03-a-stored-ticket').stagesFile,
    '{"at":"2026',
  );

  assert.deepEqual(
    readTicket(stateDir, '2026-08-03-a-stored-ticket').stageLog.map((e) => e.stage),
    ['ergon'],
  );
});

// The stage log is added when we read, never saved. Saving it would give us
// two answers that could disagree, so writeTicket must drop any log it gets.
test('writeTicket refuses to persist a stageLog handed to it', () => {
  const stateDir = tempStateDir();
  writeTicket(stateDir, makeTicket());
  recordStage(stateDir, '2026-08-03-a-stored-ticket', STAGES.ERGON);

  const loaded = readTicket(stateDir, '2026-08-03-a-stored-ticket');
  // Here a caller hands the log straight back, with a fake close entry and a
  // fake field. The cast is only there to get past the type check.
  writeTicket(stateDir, {
    ...loaded,
    phase: 'closed',
    stageLog: [...loaded.stageLog, { at: loaded.stageLog[0].at, stage: STAGES.LYSIS, note: null }],
  } as TicketDraft);

  const stored = JSON.parse(
    fs.readFileSync(
      ticketFiles(ticketsDir(stateDir), '2026-08-03-a-stored-ticket').ticketFile,
      'utf8',
    ),
  );
  assert.equal('stageLog' in stored, false);
  // Any made-up key, not only this one. We list fields by name so that
  // nothing a caller invents lands on disk.
  assert.equal('phase' in stored, false);
  // The real log still ends at ergon, so the fake close did nothing.
  assert.equal(
    isClosed(readTicket(stateDir, '2026-08-03-a-stored-ticket')),
    false,
    'a fabricated lysis entry took hold',
  );
});

test("archiveClosedTicket moves the ticket's whole folder, and it stays readable", () => {
  const stateDir = tempStateDir();
  writeTicket(stateDir, makeTicket());
  recordStage(stateDir, '2026-08-03-a-stored-ticket', STAGES.LYSIS);

  archiveClosedTicket(stateDir, '2026-08-03-a-stored-ticket');

  assert.equal(fs.existsSync(path.join(stateDir, 'tickets', '2026-08-03-a-stored-ticket')), false);
  const closedDir = path.join(stateDir, 'tickets', 'closed', '2026-08-03-a-stored-ticket');
  assert.ok(fs.existsSync(path.join(closedDir, 'ticket.json')));
  assert.ok(fs.existsSync(path.join(closedDir, 'stages')));

  const loaded = readTicket(stateDir, '2026-08-03-a-stored-ticket');
  assert.equal(isClosed(loaded), true);
  assert.deepEqual(
    loaded.stageLog.map((e) => e.stage),
    ['lysis'],
  );
});

// If the lock lived inside the folder, archiving would rename it while held:
// the holder would own a dead path, and a second process could take a fresh
// lock at the new one. This is the test that says it does not.
test('archiving a ticket does not move the write lock out from under its holder', () => {
  const stateDir = tempStateDir();
  const id = '2026-08-03-a-stored-ticket';
  writeTicket(stateDir, makeTicket());
  recordStage(stateDir, id, STAGES.LYSIS);

  withTicketLock(stateDir, id, (lease) => {
    const lockPath = ticketLockPath(stateDir, id);
    assert.ok(fs.existsSync(lockPath), 'lock file was not taken');

    archiveClosedTicket(stateDir, id);

    assert.equal(ticketLockPath(stateDir, id), lockPath, 'the lock path moved with the ticket');
    assert.ok(fs.existsSync(lockPath), 'the lock file went with the folder');
    // Still ours: nothing else could have taken it at a new path.
    assert.doesNotThrow(() => lease.assertHeld());
  });
});

// That is the point of the closed/ folder.
// The normal path never opens a finished ticket at all.
test('listTickets reads closed tickets only when asked to', () => {
  const stateDir = tempStateDir();
  writeTicket(stateDir, makeTicket({ id: '2026-08-03-a-stored-ticket' }));
  writeTicket(stateDir, makeTicket({ id: '2026-08-04-acquire-a-worktree' }));
  recordStage(stateDir, '2026-08-04-acquire-a-worktree', STAGES.LYSIS);
  archiveClosedTicket(stateDir, '2026-08-04-acquire-a-worktree');

  assert.deepEqual(
    listTickets(stateDir).map((t) => t.id),
    ['2026-08-03-a-stored-ticket'],
  );
  assert.deepEqual(
    listTickets(stateDir, { includeClosed: true })
      .map((t) => t.id)
      .sort(),
    ['2026-08-03-a-stored-ticket', '2026-08-04-acquire-a-worktree'],
  );
});

// A crash can leave a closed ticket in the open folder.
// The log is the truth. The folder is only a shortcut.
test('a closed ticket left in the active directory is still excluded', () => {
  const stateDir = tempStateDir();
  writeTicket(stateDir, makeTicket());
  recordStage(stateDir, '2026-08-03-a-stored-ticket', STAGES.LYSIS);
  // Deliberately not archived.

  assert.deepEqual(listTickets(stateDir), []);
});

test('cached checks are returned only for the exact key they were stored under', () => {
  const stateDir = tempStateDir();
  writeTicket(stateDir, makeTicket());
  const results = [{ name: 'test', passed: true, output: 'ok\n' }];

  saveCachedChecks(stateDir, '2026-08-03-a-stored-ticket', 'sha-abc lint null', results);
  const ticket = readTicket(stateDir, '2026-08-03-a-stored-ticket');

  assert.deepEqual(readCachedChecks(ticket, 'sha-abc lint null'), results);
  assert.equal(readCachedChecks(ticket, 'sha-def lint null'), null, 'different commit');
  assert.equal(readCachedChecks(ticket, 'sha-abc other null'), null, 'different check command');
});

// A null key means we can not tell which code this is, usually a dirty
// worktree. Trusting it is how an old pass gets reported as a new one.
test('a null check key is never stored and never matches', () => {
  const stateDir = tempStateDir();
  writeTicket(stateDir, makeTicket());

  saveCachedChecks(stateDir, '2026-08-03-a-stored-ticket', null, [
    { name: 'test', passed: true, output: '' },
  ]);
  const ticket = readTicket(stateDir, '2026-08-03-a-stored-ticket');

  assert.equal(ticket.checks, null);
  assert.equal(readCachedChecks(ticket, null), null);
});

test('listTickets excludes closed tickets by default', () => {
  const stateDir = tempStateDir();
  writeTicket(stateDir, makeTicket({ id: '2026-08-03-a-stored-ticket' }));
  // Closed means lysis has run. There is no field to set, so a ticket can
  // not claim to be closed without the log to prove it.
  writeTicket(stateDir, makeTicket({ id: '2026-08-04-acquire-a-worktree' }));
  recordStage(stateDir, '2026-08-04-acquire-a-worktree', STAGES.LYSIS);

  const active = listTickets(stateDir);
  assert.deepEqual(
    active.map((t) => t.id),
    ['2026-08-03-a-stored-ticket'],
  );

  const all = listTickets(stateDir, { includeClosed: true });
  assert.deepEqual(all.map((t) => t.id).sort(), [
    '2026-08-03-a-stored-ticket',
    '2026-08-04-acquire-a-worktree',
  ]);
});

test('writeTicket/readTicket refuse an id shaped like a path-traversal attempt', () => {
  const stateDir = tempStateDir();

  assert.throws(
    () => writeTicket(stateDir, makeTicket({ id: '../../etc/passwd' })),
    /invalid ticket id/,
  );
  assert.throws(() => readTicket(stateDir, '../../etc/passwd'), /invalid ticket id/);
});

test('listTickets on a project with no tickets dir returns an empty list', () => {
  const stateDir = tempStateDir();
  assert.deepEqual(listTickets(stateDir), []);
});

// isActive is just "not closed", so no other fact may change it.
// Every ticket that stays active still holds a port and a worktree.
test('isActive is false only once lysis has run', () => {
  const log = (...stages: Stage[]): StageLogEntry[] =>
    stages.map((stage) => ({ at: '2026-07-26T00:00:00.000Z', stage, note: null }));

  assert.equal(isActive(makeTicket({ stageLog: log(STAGES.GENESIS) })), true, 'nothing recorded');
  assert.equal(
    isActive(makeTicket({ stageLog: log(STAGES.GENESIS), prUrl: 'https://x/1' })),
    true,
    'pr open',
  );
  assert.equal(
    isActive(
      makeTicket({
        stageLog: [{ at: '2026-07-26T00:00:00.000Z', stage: STAGES.ERGON, note: 'crashed' }],
      }),
    ),
    true,
    'last run crashed',
  );
  assert.equal(
    isActive(makeTicket({ stageLog: log(STAGES.GENESIS, STAGES.LYSIS) })),
    false,
    'lysis has run',
  );
});

const AT = '2026-07-26T00:00:00.000Z';
const entry = (stage: Stage, note: string | null = null): StageLogEntry => ({
  at: AT,
  stage,
  note,
});

// One test per fact, because each one answers a different question.
// A new ticket answers no to all three.
test('a ticket that has only been opened carries none of the three facts', () => {
  const ticket = makeTicket({ stageLog: [entry(STAGES.GENESIS)] });

  assert.equal(isClosed(ticket), false);
  assert.equal(hasOpenPr(ticket), false);
  assert.equal(lastRunFailed(ticket), false);
});

test('hasOpenPr is exactly whether prUrl was written', () => {
  assert.equal(
    hasOpenPr(makeTicket({ stageLog: [entry(STAGES.GENESIS)], prUrl: 'https://x/1' })),
    true,
  );
  assert.equal(hasOpenPr(makeTicket({ stageLog: [entry(STAGES.GENESIS)] })), false);
});

// All three bad endings have their own name,
// so the CLI can tell you which one happened.
test('lastRunFailed reads the note on the last ergon run', () => {
  for (const bad of [RUN_OUTCOMES.CRASHED, RUN_OUTCOMES.TIMED_OUT, RUN_OUTCOMES.CHECKS_FAILED]) {
    const ticket = makeTicket({ stageLog: [entry(STAGES.ERGON, bad)] });
    assert.equal(lastRunOutcome(ticket), bad, bad);
    assert.equal(lastRunFailed(ticket), true, bad);
  }

  const clean = makeTicket({ stageLog: [entry(STAGES.ERGON, RUN_OUTCOMES.OK)] });
  assert.equal(lastRunOutcome(clean), RUN_OUTCOMES.OK);
  assert.equal(lastRunFailed(clean), false);

  // Nothing has run, so there is no ending to report. That is not the same
  // as a run that ended with no note.
  assert.equal(lastRunOutcome(makeTicket({ stageLog: [entry(STAGES.GENESIS)] })), null);
});

// Reads the same log, but looks at review instead of ergon.
// The review step writes that note itself, so this is a plain read.
test('lastReviewFailed is true only when the last review recorded failing checks', () => {
  const failed = makeTicket({ stageLog: [entry(STAGES.REVIEW, RUN_OUTCOMES.CHECKS_FAILED)] });
  assert.equal(lastReviewOutcome(failed), RUN_OUTCOMES.CHECKS_FAILED);
  assert.equal(lastReviewFailed(failed), true);

  // Stricter than lastRunFailed on purpose. You can still push with
  // checks-unknown. Only a real failing check blocks a push.
  const unknown = makeTicket({ stageLog: [entry(STAGES.REVIEW, RUN_OUTCOMES.CHECKS_UNKNOWN)] });
  assert.equal(lastReviewFailed(unknown), false);

  const clean = makeTicket({ stageLog: [entry(STAGES.REVIEW, RUN_OUTCOMES.OK)] });
  assert.equal(lastReviewFailed(clean), false);

  // No review at all. Not the same as a review that ran and passed.
  const never = makeTicket({ stageLog: [entry(STAGES.ERGON, RUN_OUTCOMES.OK)] });
  assert.equal(lastReviewOutcome(never), null);
  assert.equal(lastReviewFailed(never), false);
});

// A later good review beats an earlier bad one.
// We read the last matching entry in the log, not the first.
test('lastReviewFailed reflects only the MOST RECENT review, not an earlier one', () => {
  const ticket = makeTicket({
    stageLog: [
      entry(STAGES.REVIEW, RUN_OUTCOMES.CHECKS_FAILED),
      entry(STAGES.ERGON, RUN_OUTCOMES.OK),
      entry(STAGES.REVIEW, RUN_OUTCOMES.OK),
    ],
  });

  assert.equal(lastReviewFailed(ticket), false);
});

test('isClosed is lysis appearing anywhere in the log', () => {
  assert.equal(
    isClosed(makeTicket({ stageLog: [entry(STAGES.GENESIS), entry(STAGES.LYSIS)] })),
    true,
  );
  assert.equal(isClosed(makeTicket({ stageLog: [entry(STAGES.GENESIS)] })), false);
  // Anything added after the close must not make the ticket look live again.
  assert.equal(
    isClosed(makeTicket({ stageLog: [entry(STAGES.LYSIS), entry(STAGES.ERGON, 'ok')] })),
    true,
  );
});

// A ticket with no .stages file gets an empty log, and every check must
// still answer without throwing, or the whole listing breaks.
test('every fact answers on a ticket with an empty stage log', () => {
  const ticket = makeTicket({ stageLog: [] });

  assert.equal(isClosed(ticket), false);
  assert.equal(isActive(ticket), true);
  assert.equal(hasOpenPr(ticket), false);
  assert.equal(lastRunOutcome(ticket), null);
  assert.equal(lastRunFailed(ticket), false);
  assert.equal(isReviewedSinceLastChange(ticket), false);
  assert.equal(currentStage(ticket), null);
  assert.equal(describeTicket(ticket), '-');
});

// A good run replaces a bad one, with nothing to reset by hand.
// That is why the outcome is never saved as a flag.
test('a clean rerun clears a failed last run on its own', () => {
  const ticket = makeTicket({
    stageLog: [
      entry(STAGES.ERGON, RUN_OUTCOMES.CHECKS_FAILED),
      entry(STAGES.ERGON, RUN_OUTCOMES.OK),
    ],
  });

  assert.equal(lastRunFailed(ticket), false);
  assert.equal(lastRunOutcome(ticket), RUN_OUTCOMES.OK, 'the later entry is the one that counts');
});

// The three facts are separate, so one ticket can have all of them at once.
// Which one wins is decided by the order each command asks, not by the data.
test('all three facts can be true of the same ticket', () => {
  const ticket = makeTicket({
    prUrl: 'https://x/1',
    stageLog: [entry(STAGES.ERGON, RUN_OUTCOMES.CRASHED), entry(STAGES.LYSIS)],
  });

  assert.equal(isClosed(ticket), true);
  assert.equal(lastRunFailed(ticket), true);
  assert.equal(hasOpenPr(ticket), true);
});

// The line printed by `ergon --status` and by `lysis`.
// Position comes first, because that is the word you look for in a list.
test('describeTicket puts the position first and the flags beside it', () => {
  const at = (...entries: ReturnType<typeof entry>[]) => makeTicket({ stageLog: entries });

  assert.equal(describeTicket(at(entry(STAGES.GENESIS))), 'planned');
  assert.equal(describeTicket(at(entry(STAGES.ERGON, RUN_OUTCOMES.OK))), 'coded');
  assert.equal(describeTicket(at(entry(STAGES.ERGON), entry(STAGES.REVIEW))), 'reviewed');
  assert.equal(describeTicket(at(entry(STAGES.REVIEW), entry(STAGES.EPISTLE))), 'pushed');

  // The flag is the ending itself. `crashed` and `checks-failed` need
  // different fixes, so one shared word would help nobody.
  assert.equal(describeTicket(at(entry(STAGES.ERGON, RUN_OUTCOMES.CRASHED))), 'coded  [crashed]');
  assert.equal(
    describeTicket(at(entry(STAGES.ERGON, RUN_OUTCOMES.CHECKS_FAILED))),
    'coded  [checks-failed]',
  );
  assert.equal(
    describeTicket(at(entry(STAGES.ERGON, RUN_OUTCOMES.TIMED_OUT))),
    'coded  [timed-out]',
  );
  assert.equal(
    describeTicket(makeTicket({ prUrl: 'https://x/1', stageLog: [entry(STAGES.EPISTLE)] })),
    'pushed  [pr-open]',
  );
  assert.equal(
    describeTicket(
      makeTicket({
        prUrl: 'https://x/1',
        stageLog: [entry(STAGES.ERGON, RUN_OUTCOMES.CRASHED)],
      }),
    ),
    'coded  [crashed pr-open]',
  );
});

// Closed prints on its own, whatever else is true. There is nothing left
// to do, and skills/lysis.md copies this text exactly.
test('describeTicket renders a closed ticket as just closed', () => {
  assert.equal(
    describeTicket(
      makeTicket({
        prUrl: 'https://x/1',
        stageLog: [entry(STAGES.ERGON, RUN_OUTCOMES.CRASHED), entry(STAGES.LYSIS)],
      }),
    ),
    'closed',
  );
});

// Each stage of the step-by-step flow has its own label, and every label names what is DONE. PLAN
// shares "planned" with GENESIS: both mean ready to code.
test('describeTicket renders each phased-flow stage with its own label', () => {
  const at = (...entries: ReturnType<typeof entry>[]) => makeTicket({ stageLog: entries });

  assert.equal(describeTicket(at(entry(STAGES.CREATE))), 'brainstorming');
  assert.equal(describeTicket(at(entry(STAGES.CREATE), entry(STAGES.SPEC))), 'spec-written');
  assert.equal(
    describeTicket(at(entry(STAGES.CREATE), entry(STAGES.SPEC), entry(STAGES.PLAN))),
    'planned',
  );
});

test('isCancelled is true only once cancel has been recorded, and isClosed agrees', () => {
  const brainstorming = makeTicket({ stageLog: [entry(STAGES.CREATE)] });
  assert.equal(isCancelled(brainstorming), false);
  assert.equal(isClosed(brainstorming), false);

  const cancelled = makeTicket({ stageLog: [entry(STAGES.CREATE), entry(STAGES.CANCEL)] });
  assert.equal(isCancelled(cancelled), true);
  assert.equal(isClosed(cancelled), true, 'cancel is a terminal state, same as lysis');
});

// Cancelled needs its own word, so we check it before closed.
// Thrown away early and finished properly are two different endings.
test('describeTicket renders a cancelled ticket as cancelled, not closed', () => {
  assert.equal(
    describeTicket(makeTicket({ stageLog: [entry(STAGES.CREATE), entry(STAGES.CANCEL)] })),
    'cancelled',
  );
});

test('writeTicket then readTicket round-trips port and planCommit', () => {
  const stateDir = tempStateDir();
  const ticket = makeTicket({ port: 4100, planCommit: 'abc123' });

  writeTicket(stateDir, ticket);
  const loaded = readTicket(stateDir, ticket.id);

  assert.equal(loaded.port, 4100);
  assert.equal(loaded.planCommit, 'abc123');
});

test("title round-trips, and defaults to null — it's cosmetic, the id is what everything else uses", () => {
  const stateDir = tempStateDir();
  writeTicket(stateDir, makeTicket({ title: 'Add dark mode toggle' }));
  assert.equal(readTicket(stateDir, '2026-08-03-a-stored-ticket').title, 'Add dark mode toggle');

  const stateDir2 = tempStateDir();
  writeTicket(stateDir2, makeTicket());
  assert.equal(readTicket(stateDir2, '2026-08-03-a-stored-ticket').title, null);
});

test('port and planCommit default to null', () => {
  const stateDir = tempStateDir();
  writeTicket(stateDir, makeTicket());

  const loaded = readTicket(stateDir, '2026-08-03-a-stored-ticket');

  assert.equal(loaded.port, null);
  assert.equal(loaded.planCommit, null);
});

test('a ticket with no ethos candidates round-trips an empty array', () => {
  const stateDir = tempStateDir();
  writeTicket(stateDir, makeTicket());

  assert.deepEqual(readTicket(stateDir, '2026-08-03-a-stored-ticket').ethosCandidates, []);
});

test('appendEthosCandidate adds a bullet that survives a later writeTicket call', () => {
  const stateDir = tempStateDir();
  writeTicket(stateDir, makeTicket());

  appendEthosCandidate(stateDir, '2026-08-03-a-stored-ticket', {
    target: T.CODE,
    text: 'prefer composition',
  });
  appendEthosCandidate(stateDir, '2026-08-03-a-stored-ticket', {
    target: T.DESIGN,
    text: 'no centered text',
  });
  appendEthosCandidate(stateDir, '2026-08-03-a-stored-ticket', {
    target: T.ARCHITECTURE,
    text: 'the api layer never imports from workers',
  });

  const afterAppend = readTicket(stateDir, '2026-08-03-a-stored-ticket');
  assert.deepEqual(afterAppend.ethosCandidates, [
    { status: 'pending', target: 'ETHOS_CODE', source: 'agent', text: 'prefer composition' },
    { status: 'pending', target: 'ETHOS_DESIGN', source: 'agent', text: 'no centered text' },
    {
      status: 'pending',
      target: 'ETHOS_ARCHITECTURE',
      source: 'agent',
      text: 'the api layer never imports from workers',
    },
  ]);

  // Pretend a later update happens, like saving the PR url.
  // The ethos candidates must not be wiped out.
  writeTicket(stateDir, { ...afterAppend, prUrl: 'https://x/1' });
  assert.deepEqual(
    readTicket(stateDir, '2026-08-03-a-stored-ticket').ethosCandidates,
    afterAppend.ethosCandidates,
  );
});

test('specText extraction stops before a following Ethos candidates section', () => {
  const stateDir = tempStateDir();
  writeTicket(stateDir, makeTicket({ specText: 'fix the thing' }));
  appendEthosCandidate(stateDir, '2026-08-03-a-stored-ticket', {
    target: T.CODE,
    text: 'some rule',
  });

  assert.equal(readTicket(stateDir, '2026-08-03-a-stored-ticket').specText, 'fix the thing');
});

test('a candidate lands as pending, and --from you is recorded as its source', () => {
  const stateDir = tempStateDir();
  writeTicket(stateDir, makeTicket());

  appendEthosCandidate(stateDir, '2026-08-03-a-stored-ticket', {
    target: T.SECURITY,
    text: 'never log request bodies',
    source: CANDIDATE_SOURCE.YOU,
  });

  const [candidate] = readTicket(stateDir, '2026-08-03-a-stored-ticket').ethosCandidates;
  assert.equal(candidate.status, CANDIDATE_STATUS.PENDING);
  assert.equal(candidate.source, CANDIDATE_SOURCE.YOU);
});

// Nothing may arrive already approved. That would be a rule
// that no human ever agreed to.
test('appendEthosCandidate cannot create an already-decided candidate', () => {
  const stateDir = tempStateDir();
  writeTicket(stateDir, makeTicket());

  // `status` is not a real option. This copies a caller trying to sneak one
  // in, and the cast is only there to get past the type check.
  appendEthosCandidate(stateDir, '2026-08-03-a-stored-ticket', {
    target: T.CODE,
    text: 'sneaky',
    status: CANDIDATE_STATUS.KEPT,
  } as Parameters<typeof appendEthosCandidate>[2]);

  assert.equal(
    readTicket(stateDir, '2026-08-03-a-stored-ticket').ethosCandidates[0].status,
    'pending',
  );
});

test('appendEthosCandidate rejects an unknown source rather than filing it', () => {
  const stateDir = tempStateDir();
  writeTicket(stateDir, makeTicket());

  assert.throws(
    () =>
      // 'boss' is not a real source. This checks the guard that runs at
      // run time, so the cast gets past the type check.
      appendEthosCandidate(stateDir, '2026-08-03-a-stored-ticket', {
        target: T.CODE,
        text: 'x',
        source: 'boss',
      } as unknown as Parameters<typeof appendEthosCandidate>[2]),
    /unknown candidate source "boss"/,
  );
  assert.deepEqual(readTicket(stateDir, '2026-08-03-a-stored-ticket').ethosCandidates, []);
});

test('decidePendingCandidates marks the picked ones kept and the rest discarded', () => {
  const stateDir = tempStateDir();
  writeTicket(stateDir, makeTicket());
  for (const text of ['one', 'two', 'three']) {
    appendEthosCandidate(stateDir, '2026-08-03-a-stored-ticket', { target: T.CODE, text });
  }

  const { kept, decided } = decidePendingCandidates(stateDir, '2026-08-03-a-stored-ticket', [1, 3]);

  assert.deepEqual(
    kept.map((c) => c.text),
    ['one', 'three'],
  );
  assert.equal(decided, 3);
  assert.deepEqual(
    readTicket(stateDir, '2026-08-03-a-stored-ticket').ethosCandidates.map((c) => [
      c.text,
      c.status,
    ]),
    [
      ['one', 'kept'],
      ['two', 'discarded'],
      ['three', 'kept'],
    ],
  );
});

// The list a human reads only numbers the pending ones. If we numbered from
// the top again, "keep 1" would hit the wrong candidate.
test('a second decision round numbers over the remaining pending only', () => {
  const stateDir = tempStateDir();
  writeTicket(stateDir, makeTicket());
  for (const text of ['first', 'second']) {
    appendEthosCandidate(stateDir, '2026-08-03-a-stored-ticket', { target: T.CODE, text });
  }
  decidePendingCandidates(stateDir, '2026-08-03-a-stored-ticket', [1]);

  appendEthosCandidate(stateDir, '2026-08-03-a-stored-ticket', {
    target: T.CODE,
    text: 'late arrival',
  });
  const stillPending = pendingCandidates(readTicket(stateDir, '2026-08-03-a-stored-ticket'));
  assert.deepEqual(
    stillPending.map((c) => c.text),
    ['late arrival'],
  );

  const { kept } = decidePendingCandidates(stateDir, '2026-08-03-a-stored-ticket', [1]);
  assert.deepEqual(
    kept.map((c) => c.text),
    ['late arrival'],
  );
  assert.deepEqual(
    readTicket(stateDir, '2026-08-03-a-stored-ticket').ethosCandidates.map((c) => [
      c.text,
      c.status,
    ]),
    [
      ['first', 'kept'],
      ['second', 'discarded'],
      ['late arrival', 'kept'],
    ],
  );
});

test('decided candidates survive a later unrelated writeTicket', () => {
  const stateDir = tempStateDir();
  writeTicket(stateDir, makeTicket());
  appendEthosCandidate(stateDir, '2026-08-03-a-stored-ticket', {
    target: T.SECURITY,
    text: 'tenant id on every query',
    source: CANDIDATE_SOURCE.YOU,
  });
  decidePendingCandidates(stateDir, '2026-08-03-a-stored-ticket', [1]);

  const loaded = readTicket(stateDir, '2026-08-03-a-stored-ticket');
  writeTicket(stateDir, { ...loaded, prUrl: 'https://x/1' });

  assert.deepEqual(readTicket(stateDir, '2026-08-03-a-stored-ticket').ethosCandidates, [
    {
      status: 'kept',
      target: 'ETHOS_SECURITY',
      source: 'you',
      text: 'tenant id on every query',
    },
  ]);
});

test('the stage log round-trips, in order, with notes', () => {
  const stateDir = tempStateDir();
  writeTicket(stateDir, makeTicket());

  recordStage(stateDir, '2026-08-03-a-stored-ticket', STAGES.ERGON);
  recordStage(stateDir, '2026-08-03-a-stored-ticket', STAGES.REVIEW);
  recordStage(stateDir, '2026-08-03-a-stored-ticket', STAGES.EPISTLE, 'unreviewed');

  const log = readTicket(stateDir, '2026-08-03-a-stored-ticket').stageLog;
  assert.deepEqual(
    log.map((e) => e.stage),
    ['ergon', 'review', 'epistle'],
  );
  assert.deepEqual(
    log.map((e) => e.note),
    [null, null, 'unreviewed'],
  );
  for (const entry of log) assert.match(entry.at, /^\d{4}-\d{2}-\d{2}T/);
});

test('currentStage is the last thing that ran, null before anything has', () => {
  const stateDir = tempStateDir();
  writeTicket(stateDir, makeTicket());

  assert.equal(currentStage(readTicket(stateDir, '2026-08-03-a-stored-ticket')), null);
  recordStage(stateDir, '2026-08-03-a-stored-ticket', STAGES.ERGON);
  assert.equal(currentStage(readTicket(stateDir, '2026-08-03-a-stored-ticket')), 'ergon');
  recordStage(stateDir, '2026-08-03-a-stored-ticket', STAGES.REVIEW);
  assert.equal(currentStage(readTicket(stateDir, '2026-08-03-a-stored-ticket')), 'review');
});

// This is why we keep a log and not one field. The real flow goes in
// circles, and one field could not say how many times it went round.
test('the log records a loop, keeping every lap', () => {
  const stateDir = tempStateDir();
  writeTicket(stateDir, makeTicket());

  for (const stage of [STAGES.ERGON, STAGES.REVIEW, STAGES.ERGON, STAGES.REVIEW]) {
    recordStage(stateDir, '2026-08-03-a-stored-ticket', stage);
  }

  assert.deepEqual(
    readTicket(stateDir, '2026-08-03-a-stored-ticket').stageLog.map((e) => e.stage),
    ['ergon', 'review', 'ergon', 'review'],
  );
});

// Order comes from the position in the log, not the time. Two stages can
// share the same millisecond, so times can not tell us which came first.
test('lastStageIndex finds the most recent occurrence even when timestamps tie', () => {
  const stateDir = tempStateDir();
  writeTicket(stateDir, makeTicket());
  recordStage(stateDir, '2026-08-03-a-stored-ticket', STAGES.REVIEW);
  recordStage(stateDir, '2026-08-03-a-stored-ticket', STAGES.ERGON);
  recordStage(stateDir, '2026-08-03-a-stored-ticket', STAGES.REVIEW);

  const ticket = readTicket(stateDir, '2026-08-03-a-stored-ticket');
  assert.equal(lastStageIndex(ticket, STAGES.REVIEW), 2);
  assert.equal(lastStageIndex(ticket, STAGES.ERGON), 1);
  assert.equal(lastStageIndex(ticket, STAGES.EPISTLE), -1);
  assert.equal(lastStageAt(ticket, STAGES.REVIEW), ticket.stageLog[2].at);
  assert.equal(lastStageAt(ticket, STAGES.EPISTLE), null);
});

// "Was it ever reviewed" is the weak question. Reviewed, then three more
// commits, means the branch is not reviewed.
test('isReviewedSinceLastChange compares the last review to the last code change', () => {
  const stateDir = tempStateDir();
  writeTicket(stateDir, makeTicket());
  const read = () => readTicket(stateDir, '2026-08-03-a-stored-ticket');

  assert.equal(isReviewedSinceLastChange(read()), false, 'never reviewed');

  recordStage(stateDir, '2026-08-03-a-stored-ticket', STAGES.ERGON);
  assert.equal(isReviewedSinceLastChange(read()), false, 'coded, not yet reviewed');

  recordStage(stateDir, '2026-08-03-a-stored-ticket', STAGES.REVIEW);
  assert.equal(isReviewedSinceLastChange(read()), true, 'reviewed after coding');

  recordStage(stateDir, '2026-08-03-a-stored-ticket', STAGES.ERGON);
  assert.equal(isReviewedSinceLastChange(read()), false, 'code changed after the review');

  recordStage(stateDir, '2026-08-03-a-stored-ticket', STAGES.REVIEW);
  assert.equal(isReviewedSinceLastChange(read()), true, 'reviewed again');
});

// Work done by hand never runs ergon, and reviewing it is still a review.
// Refusing that would block a normal way of working.
test('a review with no ergon at all counts as reviewed', () => {
  const stateDir = tempStateDir();
  writeTicket(stateDir, makeTicket());
  recordStage(stateDir, '2026-08-03-a-stored-ticket', STAGES.REVIEW);

  assert.equal(isReviewedSinceLastChange(readTicket(stateDir, '2026-08-03-a-stored-ticket')), true);
});

// Review, more code, then review again. Every round lands in order,
// and we must read the newest review, not the first one we find.
test('a second review lap orders after the first, and the later one wins', () => {
  const stateDir = tempStateDir();
  writeTicket(stateDir, makeTicket());

  recordStage(stateDir, '2026-08-03-a-stored-ticket', STAGES.ERGON);
  recordStage(stateDir, '2026-08-03-a-stored-ticket', STAGES.REVIEW);
  recordStage(stateDir, '2026-08-03-a-stored-ticket', STAGES.ERGON);
  assert.equal(
    isReviewedSinceLastChange(readTicket(stateDir, '2026-08-03-a-stored-ticket')),
    false,
    'code changed after the review',
  );

  recordStage(stateDir, '2026-08-03-a-stored-ticket', STAGES.REVIEW);
  const ticket = readTicket(stateDir, '2026-08-03-a-stored-ticket');
  assert.deepEqual(
    ticket.stageLog.map((e) => e.stage),
    ['ergon', 'review', 'ergon', 'review'],
  );
  assert.equal(
    lastStageIndex(ticket, STAGES.REVIEW),
    3,
    'the later review wins, not the first hit',
  );
  assert.equal(isReviewedSinceLastChange(ticket), true);
});

test('the stage log survives an unrelated writeTicket, alongside ethos candidates', () => {
  const stateDir = tempStateDir();
  writeTicket(stateDir, makeTicket());
  recordStage(stateDir, '2026-08-03-a-stored-ticket', STAGES.ERGON);
  appendEthosCandidate(stateDir, '2026-08-03-a-stored-ticket', { target: T.CODE, text: 'a rule' });

  const loaded = readTicket(stateDir, '2026-08-03-a-stored-ticket');
  writeTicket(stateDir, { ...loaded, prUrl: 'https://x/1' });

  const after = readTicket(stateDir, '2026-08-03-a-stored-ticket');
  assert.deepEqual(after.stageLog, loaded.stageLog);
  assert.deepEqual(after.ethosCandidates, loaded.ethosCandidates);
  assert.equal(after.specText, 'fix the thing');
});

// --------------------------------------------------------------------------- Review findings — what
// a fresh reviewer decided, saved through the CLI. ---------------------------------------------------------------------------

test('appendReviewFinding records a clean verdict with no finding text needed', () => {
  const stateDir = tempStateDir();
  writeTicket(stateDir, makeTicket());

  const findings = appendReviewFinding(stateDir, '2026-08-03-a-stored-ticket', {
    verdict: REVIEW_VERDICT.CLEAN,
  });

  assert.equal(findings.length, 1);
  assert.equal(findings[0].verdict, 'clean');
  assert.equal(findings[0].finding, null);
  assert.equal(reviewFindings(readTicket(stateDir, '2026-08-03-a-stored-ticket')).length, 1);
});

test('appendReviewFinding refuses a blocking verdict with no finding — nothing to act on', () => {
  const stateDir = tempStateDir();
  writeTicket(stateDir, makeTicket());

  assert.throws(
    () =>
      appendReviewFinding(stateDir, '2026-08-03-a-stored-ticket', {
        verdict: REVIEW_VERDICT.BLOCKING,
      }),
    /a blocking verdict needs --finding/,
  );
});

test('appendReviewFinding refuses an unknown verdict', () => {
  const stateDir = tempStateDir();
  writeTicket(stateDir, makeTicket());

  assert.throws(
    // 'maybe' is not a real verdict. Same idea as the bad-source test above.
    () =>
      appendReviewFinding(stateDir, '2026-08-03-a-stored-ticket', {
        verdict: 'maybe',
      } as unknown as Parameters<typeof appendReviewFinding>[2]),
    /unknown review verdict "maybe"/,
  );
});

test("appendReviewFinding accumulates one entry per call, same as psyche's ethos candidates", () => {
  const stateDir = tempStateDir();
  writeTicket(stateDir, makeTicket());

  appendReviewFinding(stateDir, '2026-08-03-a-stored-ticket', {
    verdict: REVIEW_VERDICT.BLOCKING,
    finding: 'signup.js:44 — no rate limit on invite redeem',
  });
  const findings = appendReviewFinding(stateDir, '2026-08-03-a-stored-ticket', {
    verdict: REVIEW_VERDICT.BLOCKING,
    finding: 'signup.js:61 — token never expires',
  });

  assert.equal(findings.length, 2);
  assert.equal(hasBlockingFindings(readTicket(stateDir, '2026-08-03-a-stored-ticket')), true);
});

// The reviewer sends one call per finding, often many at once. We start real
// processes here, because the bug only shows up with real timing.
test('appendReviewFinding survives several concurrent processes reporting findings at once', async () => {
  const stateDir = tempStateDir();
  writeTicket(stateDir, makeTicket());

  const workerPath = path.join(makeTempDir('krisis'), 'worker.mjs');
  fs.writeFileSync(
    workerPath,
    `
import { appendReviewFinding } from ${JSON.stringify(path.resolve('src/ticket/ticketStore.js'))};
const [stateDir, id, n] = process.argv.slice(2);
appendReviewFinding(stateDir, id, {
  verdict: "blocking",
  finding: \`src/\${n}.js:1 — finding \${n}\`,
});
`,
  );

  const N = 6;
  await Promise.all(
    Array.from({ length: N }, (_, i) => {
      return new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [
          ...NODE_TSX_ARGS,
          workerPath,
          stateDir,
          '2026-08-03-a-stored-ticket',
          String(i),
        ]);
        let stderr = '';
        child.stderr.on('data', (d) => (stderr += d));
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(stderr))));
      });
    }),
  );

  const findings = reviewFindings(readTicket(stateDir, '2026-08-03-a-stored-ticket'));
  assert.equal(findings.length, N, `expected all ${N} findings, got ${findings.length}`);
  for (let i = 0; i < N; i++) {
    assert.ok(
      findings.some((f) => f.finding?.includes(`finding ${i}`)),
      `finding ${i} was dropped`,
    );
  }
});

test('reviewFindings and hasBlockingFindings read [] / false for a ticket with none recorded', () => {
  const ticket = makeTicket();
  assert.deepEqual(reviewFindings(ticket), []);
  assert.equal(hasBlockingFindings(ticket), false);
});

// The bug this guards: a fixed problem from round 1 must not make
// a clean round 2 still look blocked.
test('clearReviewFindings wipes the slate so a new round starts clean', () => {
  const stateDir = tempStateDir();
  writeTicket(stateDir, makeTicket());
  appendReviewFinding(stateDir, '2026-08-03-a-stored-ticket', {
    verdict: REVIEW_VERDICT.BLOCKING,
    finding: 'round 1 problem',
  });
  assert.equal(hasBlockingFindings(readTicket(stateDir, '2026-08-03-a-stored-ticket')), true);

  clearReviewFindings(stateDir, '2026-08-03-a-stored-ticket');

  assert.deepEqual(reviewFindings(readTicket(stateDir, '2026-08-03-a-stored-ticket')), []);
  assert.equal(hasBlockingFindings(readTicket(stateDir, '2026-08-03-a-stored-ticket')), false);
});

// --------------------------------------------------------------------------- Aporia means stuck.
// Without it, a coder that gave up at step 2 and one that finished all 8 steps both look the same. ---------------------------------------------------------------------------

test('recordAporia marks the ticket, hasAporia reads it back', () => {
  const stateDir = tempStateDir();
  writeTicket(stateDir, makeTicket());

  assert.equal(hasAporia(readTicket(stateDir, '2026-08-03-a-stored-ticket')), false);

  recordAporia(
    stateDir,
    '2026-08-03-a-stored-ticket',
    'step 4 assumes a table that does not exist',
  );

  const ticket = readTicket(stateDir, '2026-08-03-a-stored-ticket');
  assert.equal(hasAporia(ticket), true);
  assert.equal(ticket.aporia!.reason, 'step 4 assumes a table that does not exist');
  assert.ok(ticket.aporia!.at);
});

test('clearAporia wipes it, and is a harmless no-op when there was none', () => {
  const stateDir = tempStateDir();
  writeTicket(stateDir, makeTicket());
  recordAporia(stateDir, '2026-08-03-a-stored-ticket', 'blocked');

  clearAporia(stateDir, '2026-08-03-a-stored-ticket');
  assert.equal(hasAporia(readTicket(stateDir, '2026-08-03-a-stored-ticket')), false);

  // Calling it again with nothing to clear must not throw.
  assert.doesNotThrow(() => clearAporia(stateDir, '2026-08-03-a-stored-ticket'));
});

// --------------------------------------------------------------------------- Old bugs from
// One bad file used to break the whole listing, even though the stage log reader already skipped bad lines. ---------------------------------------------------------------------------

test('one corrupt ticket file does not hide every healthy ticket', () => {
  const stateDir = tempStateDir();
  const ids = [
    '2026-08-03-a-healthy-ticket',
    '2026-08-03-a-corrupt-ticket-file',
    '2026-08-03-a-second-healthy-ticket',
  ];
  for (const id of ids) writeTicket(stateDir, makeTicket({ id }));

  // Cut off mid-write, the way a full disk leaves a file.
  const { ticketFile } = ticketFiles(ticketsDir(stateDir), '2026-08-03-a-corrupt-ticket-file');
  fs.writeFileSync(ticketFile, '{"id":"2026-08-03-a-corrupt-ticket-file","cont');

  const listed = listTickets(stateDir).map((t) => t.id);
  assert.deepEqual(listed, ['2026-08-03-a-healthy-ticket', '2026-08-03-a-second-healthy-ticket']);
});

test('schema drift is skipped the same way truncation is', () => {
  const stateDir = tempStateDir();
  writeTicket(stateDir, makeTicket({ id: '2026-08-03-a-healthy-ticket' }));
  writeTicket(stateDir, makeTicket({ id: '2026-08-03-a-corrupt-ticket-file' }));

  const { ticketFile } = ticketFiles(ticketsDir(stateDir), '2026-08-03-a-corrupt-ticket-file');
  const stored = JSON.parse(fs.readFileSync(ticketFile, 'utf8'));
  // An upgrade that changed a field's type: port is now a string.
  fs.writeFileSync(ticketFile, JSON.stringify({ ...stored, port: '4100' }));

  assert.deepEqual(
    listTickets(stateDir).map((t) => t.id),
    ['2026-08-03-a-healthy-ticket'],
  );
});

// To fix it you need to know which file broke, and we used to not say.
test('a skipped ticket is reported, naming the file', () => {
  const stateDir = tempStateDir();
  writeTicket(stateDir, makeTicket({ id: '2026-08-03-a-healthy-ticket' }));
  const { ticketFile } = ticketFiles(ticketsDir(stateDir), '2026-08-03-a-healthy-ticket');
  fs.writeFileSync(ticketFile, 'not json at all');

  const warnings: string[] = [];
  listTickets(stateDir, { onUnreadable: (w) => warnings.push(w) });

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /2026-08-03-a-healthy-ticket[/\\]ticket\.json/);
});

// Reading ONE ticket by id must still throw. The caller asked for that exact
// ticket, so saying nothing would be worse than an error.
test('reading a corrupt ticket by id still throws', () => {
  const stateDir = tempStateDir();
  writeTicket(stateDir, makeTicket({ id: '2026-08-03-a-healthy-ticket' }));
  const { ticketFile } = ticketFiles(ticketsDir(stateDir), '2026-08-03-a-healthy-ticket');
  fs.writeFileSync(ticketFile, 'not json at all');

  assert.throws(() => readTicket(stateDir, '2026-08-03-a-healthy-ticket'));
});

// withTicketLock is the primitive several commands (createTicket, attachSpec,
// provisionTicket, guardrails --repin) were switched to, for a raw read-modify-write that used to have no <id>.json.lock at all. Unlike updateTicket, it must work before the ticket (and its directory) exists yet — that's the whole reason it can't just reuse updateTicket's read-existing-ticket-then-patch shape.
test('withTicketLock takes the lock even when the ticket file and its directory do not exist yet', () => {
  const stateDir = tempStateDir();
  const id = '2026-08-04-acquire-a-worktree';

  const result = withTicketLock(stateDir, id, () => {
    writeTicket(stateDir, makeTicket({ id }));
    return 'created';
  });

  assert.equal(result, 'created');
  assert.equal(readTicket(stateDir, id).id, id);
});

test('withTicketLock refuses while another writer holds the lock, same as updateTicket', () => {
  const stateDir = tempStateDir();
  const id = '2026-08-04-service-ports-one';
  writeTicket(stateDir, makeTicket({ id }));

  const lockPath = ticketLockPath(stateDir, id);
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), {
    flag: 'wx',
  });

  assert.throws(() => withTicketLock(stateDir, id, () => {}), /still locked/);
  assert.throws(() => updateTicket(stateDir, id, () => ({})), /still locked/);

  fs.unlinkSync(lockPath);
  // Both work again once the lock clears.
  withTicketLock(stateDir, id, () => {});
  updateTicket(stateDir, id, () => ({}));
});

// The round token was stored on the ticket in plain text, and the ticket lives in
// .glafka/ — so the one thing separating a real review from the coder self-approving was a string the coder could read. The ticket now stores only a hash.
test('the ticket stores a hash of the round token, never the token', () => {
  const stateDir = makeTempDir('token26');
  const id = '2026-08-07-add-search-filters';
  fs.mkdirSync(path.join(stateDir, 'tickets'), { recursive: true });
  const now = new Date().toISOString();
  writeTicket(stateDir, { id, created: now, updated: now });

  const token = 'a-real-round-token';
  setReviewToken(stateDir, id, token);

  const onDisk = fs.readFileSync(ticketFiles(ticketsDir(stateDir), id).ticketFile, 'utf8');
  assert.equal(onDisk.includes(token), false, 'the plaintext must not reach the file');

  // The real token still verifies.
  let findings = appendReviewFinding(stateDir, id, { verdict: 'clean', token });
  assert.equal(findings.at(-1)!.verified, true);

  // What the coder could read off the ticket does not.
  const stored = JSON.parse(onDisk).reviewToken as string;
  findings = appendReviewFinding(stateDir, id, { verdict: 'clean', token: stored });
  assert.equal(findings.at(-1)!.verified, false, 'replaying the stored value must not verify');

  fs.rmSync(stateDir, { recursive: true, force: true });
});

// The catastrophe this guard exists for: locateTicket's miss path is shared
// with writeTicket, and writeTicket's miss path CREATES. A leftover flat
// `<id>.json` is invisible to the folder layout, so the next write would
// start a fresh, empty record beside it — no error, real history gone.
test('a leftover flat <id>.json ticket is refused loudly, not overwritten', () => {
  const stateDir = tempStateDir();
  const id = '2026-08-03-a-stored-ticket';
  const dir = ticketsDir(stateDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(makeTicket({ id })));

  assert.throws(() => readTicket(stateDir, id), /old flat layout/);
  assert.throws(() => readTicket(stateDir, id), new RegExp(`${id}\\.json`));
  assert.throws(() => listTickets(stateDir), /old flat layout/);

  // And the write that would have clobbered it never lands.
  assert.throws(() => writeTicket(stateDir, makeTicket({ id })), /old flat layout/);
  assert.equal(fs.existsSync(ticketFiles(dir, id).ticketFile), false);
});

// The guard must not fire on the files that legitimately sit beside the
// folders, or every command refuses on an ordinary healthy project.
test('the flat-layout guard ignores lock files and the closed folder', () => {
  const stateDir = tempStateDir();
  const id = '2026-08-03-a-stored-ticket';
  writeTicket(stateDir, makeTicket({ id }));
  fs.writeFileSync(ticketLockPath(stateDir, id), '{}');
  writeProvisioningLock(stateDir, '2026-08-04-acquire-a-worktree', { branch: 'glafka/x' });
  fs.mkdirSync(path.join(ticketsDir(stateDir), 'closed'), { recursive: true });

  assert.doesNotThrow(() => listTickets(stateDir, { includeClosed: true }));
  assert.deepEqual(
    listTickets(stateDir).map((t) => t.id),
    [id],
  );
});
