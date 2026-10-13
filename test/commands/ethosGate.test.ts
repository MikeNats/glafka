import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseKeepArg, formatPendingListing, resolveKeep } from '../../src/memory/ethosGate.js';
import type { Ticket } from '../../src/types/ticket.js';

function pendingTicket(texts: string[]): Pick<Ticket, 'id' | 'ethosCandidates'> {
  return {
    id: '2026-08-07-fix-the-login-bypass',
    ethosCandidates: texts.map((text, i) => ({
      status: 'pending',
      target: 'ETHOS_CODE',
      source: i === 0 ? 'you' : 'agent',
      text,
    })),
  };
}

test('all expands to every pending index, none to nothing', () => {
  assert.deepEqual(parseKeepArg('all', 3), [1, 2, 3]);
  assert.deepEqual(parseKeepArg('none', 3), []);
});

test('an index list is parsed, deduped, and sorted', () => {
  assert.deepEqual(parseKeepArg('3,1', 3), [1, 3]);
  assert.deepEqual(parseKeepArg('2,2', 3), [2]);
  assert.deepEqual(parseKeepArg(' 1 , 3 ', 3), [1, 3]);
});

// A bad index must show an error, not get silently accepted.
test('a malformed selection is refused outright, not partially applied', () => {
  assert.throws(() => parseKeepArg('9', 3), /out of range/);
  assert.throws(() => parseKeepArg('0', 3), /out of range/);
  assert.throws(() => parseKeepArg('1,x', 3), /isn't a number/);
  assert.throws(() => parseKeepArg('', 3), /needs "all", "none"/);
  assert.throws(() => parseKeepArg(',,', 3), /needs "all", "none"/);
});

// Every line shows the source: your own words or an agent's guess.
test('the listing is numbered and says who proposed each rule', () => {
  const listing = formatPendingListing(pendingTicket(['mine', 'its']).ethosCandidates);

  assert.match(listing, /^ {2}1\. \[ETHOS_CODE\] \(you said\) mine$/m);
  assert.match(listing, /^ {2}2\. \[ETHOS_CODE\] \(agent\) its$/m);
});

test('nothing pending resolves to an empty decision, no flag needed', () => {
  const ticket: Pick<Ticket, 'id' | 'ethosCandidates'> = {
    id: '2026-08-07-add-dark-mode',
    ethosCandidates: [{ status: 'kept', target: 'ETHOS_CODE', source: 'you', text: 'x' }],
  };

  assert.deepEqual(resolveKeep({ ticket, keep: null, command: 'lysis' }), {
    pending: [],
    keepIndexes: [],
  });
});

// An agent runs this. The error must be plain text it can print.
test('an undecided pass is refused with the list and the way out', () => {
  const ticket = pendingTicket(['never log bodies', 'prefer composition']);

  assert.throws(
    () => resolveKeep({ ticket, keep: null, command: 'ergon --review' }),
    (err: Error) => {
      assert.match(err.message, /2 ethos candidate\(s\) awaiting a decision/);
      assert.match(err.message, /1\. \[ETHOS_CODE\] \(you said\) never log bodies/);
      assert.match(err.message, /glafka ergon --review 2026-08-07-fix-the-login-bypass --keep all/);
      assert.match(err.message, /glafka ergon --review 2026-08-07-fix-the-login-bypass --keep 1,3/);
      assert.match(
        err.message,
        /glafka ergon --review 2026-08-07-fix-the-login-bypass --keep none/,
      );
      return true;
    },
  );
});

// The error message must name the real command that ran.
test('the refusal names the calling command, not a hardcoded one', () => {
  const ticket = pendingTicket(['a rule']);

  assert.throws(
    () => resolveKeep({ ticket, keep: null, command: 'lysis' }),
    /glafka lysis 2026-08-07-fix-the-login-bypass --keep all/,
  );
});

test('indexes are validated against the pending count, not the whole pile', () => {
  const ticket: Pick<Ticket, 'id' | 'ethosCandidates'> = {
    id: '2026-08-07-add-dark-mode',
    ethosCandidates: [
      { status: 'kept', target: 'ETHOS_CODE', source: 'you', text: 'already decided' },
      { status: 'discarded', target: 'ETHOS_CODE', source: 'agent', text: 'also decided' },
      { status: 'pending', target: 'ETHOS_CODE', source: 'agent', text: 'the only live one' },
    ],
  };

  assert.deepEqual(resolveKeep({ ticket, keep: '1', command: 'lysis' }).keepIndexes, [1]);
  assert.throws(
    () => resolveKeep({ ticket, keep: '2', command: 'lysis' }),
    /there are 1 candidate/,
  );
});
