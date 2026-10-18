import { headsOf, spellings } from './contract';

// glafka on PATH, by a path, after env or xargs, the project's own copy, and through npx.
const GLAFKA_HEADS = [...headsOf('glafka'), 'node *glafka.js', 'npx *glafka'];

// glafka steps by name. A step name is a common word ("plan"), so it must come right after
// glafka: a note that says "plan first" is not blocked.
const commands = (names: string[]) => names.flatMap((name) => spellings(GLAFKA_HEADS, `${name} *`));

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

// glafka's block rules, for every way a chat may write glafka.
export const glafkaRules = {
  // A worktree (plan, heureka) or a coder (ergon) starts only from Elaia's Start button.
  plannerDenied: commands(['plan', 'ergon', 'heureka']),
  createDenied: commands(['create', 'genesis', 'heureka']),
  // Any glafka command that names another ticket, read-only ones too. A space or a quote on
  // each side of the id, so ticket `…-foo` never matches ticket `…-foo-bar`.
  otherTicketsDenied: (ids: string[]) =>
    ids.flatMap((id) => [
      afterGlafka(id),
      afterGlafka(`${id} *`),
      afterGlafka(`"${id}"*`),
      afterGlafka(`'${id}'*`),
    ]),
  pushOnly: commands(['epistle']),
  // `install` is a common word, so it must come right after glafka. A bare one installs too.
  sharedDenied: [
    ...SHARED_FLAGS.map((flag) => afterGlafka(`${flag}*`)),
    ...spellings(GLAFKA_HEADS, 'install'),
    ...commands(['install']),
  ],
};
