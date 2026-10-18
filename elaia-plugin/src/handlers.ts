import { existsSync } from 'node:fs';
import { isSafeName, readTrustItems, type CallName } from './contract';
import { TicketBriefSchema, TicketPlaceSchema } from './contract';
import { glafkaClient } from './client';
import { nameArg, namesArg, setupArg, textArg, ticketArg, type Args } from './args';
import { agentCommandFor, baseRefFor } from './config';
import { endedRuns, glafkaDir, lastResult } from './files';
import { GLAFKA_INFO } from './info';
import { runOf } from './next';
import { runGlafka } from './run';
import { glafkaTrust } from './runnables';
import { hasCoder, hasVerifier } from './setup';
import { setupAnswer } from './setupAnswer';
import { setupNext } from './setupFlow';
import { glafkaTicketGenesisPrompt, glafkaTicketRules, planFileOf } from './text';
import { toTicket } from './toTicket';

type Handler = (project: string, args: Args) => unknown;

const NO_CODER =
  'No coder agent is set (agents.coder in .glafka.json), so tickets cannot run on their own. ' +
  'Set it there, or ask the main chat to set it up.';
// `glafka plan` can set up containers, a database and the dev server.
const PLAN_TIMEOUT = 900_000;
// `ergon --background` first wakes the ticket's services. Elaia waits long for it.
const BUILD_TIMEOUT = 600_000;

function lastWords(log: string): string | null {
  try {
    return lastResult(log);
  } catch {
    return null;
  }
}

// Every call the glafka plugin answers, run with the glafka command `bin`.
export function handlers(bin: string): Record<CallName, Handler> {
  const client = glafkaClient(bin);
  const id = (args: Args) => nameArg(args, 'id');
  return {
    describe: () => GLAFKA_INFO,
    detect: (p) => ({ installed: existsSync(glafkaDir(p)) }),
    tickets: async (p) => {
      const ctx = { bin, hasVerifier: hasVerifier(p) };
      return (await client.tickets(p)).map((g) => toTicket(g, ctx));
    },
    ticket: async (p, a) => {
      const found = await client.ticket(p, id(a));
      return found ? toTicket(found, { bin, hasVerifier: hasVerifier(p) }) : null;
    },
    tokens: (p) => client.tokens(p),
    runs: (p, a) => {
      // Runs Elaia already has: listed, but their logs are not read again. A key that is no
      // plain name (a stray file like ._coder-1) is skipped, never a failure of the whole call.
      const listed: unknown[] = Array.isArray(a.copied) ? a.copied : [];
      const copied = new Set(listed.filter((k) => typeof k === 'string' && isSafeName(k)));
      const runsOf = (t: string) =>
        endedRuns(p, t).map((r) => {
          const run = runOf(r);
          return { ...run, lastWords: copied.has(run.key) ? null : lastWords(r.log) };
        });
      return Object.fromEntries(namesArg(a, 'ids').map((t) => [t, runsOf(t)]));
    },
    create: async (p, a) => ({ id: await client.create(p, textArg(a, 'idea')) }),
    next: (p, a) => client.advance(p, id(a)),
    'start-work': (p, a) => runGlafka(bin, ['plan', id(a), planFileOf(id(a))], p, PLAN_TIMEOUT),
    'start-build': (p, a) => runGlafka(bin, ['ergon', id(a), '--background'], p, BUILD_TIMEOUT),
    close: (p, a) => runGlafka(bin, ['lysis', id(a)], p, 300_000),
    cancel: (p, a) => runGlafka(bin, ['cancel', id(a)], p, 300_000),
    'base-branch': (p) => baseRefFor(p),
    'agent-command': (p) => agentCommandFor(p, ''),
    'cannot-run-alone': (p) => (hasCoder(p) ? null : NO_CODER),
    'setup-next': (p, a) => setupNext(bin, p, setupArg(a)),
    'setup-answer': (p, a) =>
      setupAnswer(bin, p, { ...setupArg(a), id: nameArg(a, 'id'), choice: nameArg(a, 'choice') }),
    'plan-prompt': (_p, a) => glafkaTicketGenesisPrompt(ticketArg(a, 'ticket', TicketBriefSchema)),
    'ticket-rules': (_p, a) => glafkaTicketRules(ticketArg(a, 'place', TicketPlaceSchema)),
    'push-prompt': (_p, a) => `/glafka:epistle ${id(a)}`,
    'trust-items': (p) => readTrustItems(p, glafkaTrust.trustFiles, glafkaTrust.runnables),
  };
}
