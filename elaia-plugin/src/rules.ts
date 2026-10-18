import { headsOf, spellings } from './contract';

// glafka on PATH, by a path, after env or xargs, the project's own copy, through npx or npm exec,
// and after timeout or nice.
const GLAFKA_HEADS = [
  ...headsOf('glafka'),
  'node *glafka.js',
  'npx *glafka',
  'npm exec *glafka',
  'timeout *glafka',
  'nice *glafka',
];
// Inside a quoted script a closing quote follows the step, so the step ends with `*`.
const SCRIPT_HEADS = ['sh -c *glafka', 'bash -c *glafka'];
const XARGS_HEADS = ['xargs *glafka', 'xargs *glafka.js'];

// Each step bare and with arguments: a rule with two `*` misses the bare command.
const bareAndWithArgs = (heads: string[], names: string[]) =>
  names.flatMap((name) => [...spellings(heads, name), ...spellings(heads, `${name} *`)]);

// glafka steps by name. A step name is a common word ("plan"), so it must come right after
// glafka: a note that says "plan first" is not blocked.
const commands = (names: string[]) => [
  ...bareAndWithArgs(GLAFKA_HEADS, names),
  ...names.flatMap((name) => spellings(SCRIPT_HEADS, `${name}*`)),
];

// Ids and flags are rare text, so they may come anywhere after glafka.
const afterGlafka = (rest: string) => `Bash(*glafka* ${rest})`;

// Flags that act on every ticket, or write files that are locked outside the main chat.
const SHARED_FLAGS = [
  'vima *--all',
  'lysis *--sweep',
  'guardrails *--level',
  'guardrails *--install-hook',
  'odysse *--keep',
  'odysse *--workspace-keep',
];

// Steps that take a ticket id. Through xargs the id comes from the input, where no rule sees it.
const TICKET_STEPS = [
  'spec',
  'plan',
  'ergon',
  'checks',
  'krisis',
  'epalitheusis',
  'aporia',
  'epistle',
  'lysis',
  'cancel',
  'poreia',
  'logos',
  'vima',
  'psyche',
  'apofasi',
];

// glafka's block rules, for every way a chat may write glafka.
export const glafkaRules = {
  // A worktree (plan, heureka) or a coder (ergon) starts only from Elaia's Start button.
  plannerDenied: commands(['plan', 'ergon', 'heureka']),
  createDenied: commands(['create', 'genesis', 'heureka']),
  // Any glafka command that names another ticket, read-only ones too. A space or a quote on
  // each side of the id, so ticket `…-foo` never matches ticket `…-foo-bar`.
  otherTicketsDenied: (ids: string[]) =>
    // An id kept in a variable (`T=<id>; glafka cancel $T`) is not in the text: no rule sees it.
    ids.flatMap((id) => [
      afterGlafka(id),
      afterGlafka(`${id} *`),
      afterGlafka(`"${id}"*`),
      afterGlafka(`'${id}'*`),
    ]),
  pushOnly: commands(['epistle']),
  // Ticket and epic chats. `install` is a common word, so it must come right after glafka.
  // No ticket step through xargs either: it would hide which ticket.
  sharedDenied: [
    ...SHARED_FLAGS.map((flag) => afterGlafka(`${flag}*`)),
    ...commands(['install']),
    ...bareAndWithArgs(XARGS_HEADS, TICKET_STEPS),
  ],
};
