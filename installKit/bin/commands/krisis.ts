import {
  appendReviewFinding,
  readTicket,
  liveReviewerRoles,
  reviewerRoles,
} from '../../../src/ticket/ticketStore.js';
import { callerRunOrigin, markExternalRunFinished } from '../../../src/ticket/background.js';
import type { ReviewVerdict } from '../../../src/types/ticket.js';
import { positionalId, assertKnownFlags } from '../cli/args.js';

// Records one review verdict, with an optional finding. `--token` is a one-time code. With no
// token, we do not trust a clean pass. Every flag this command reads. Anything else is a typo, and
// a typo used to be silently ignored — sometimes into a different action entirely.
const KRISIS_FLAGS = ['--verdict', '--finding', '--token'];
const KRISIS_USAGE =
  'usage: glafka krisis <ticket-id> --verdict clean|blocking [--finding "<file:line — what\'s wrong>"] [--token <token>]';

export function runKrisis({ args, stateDir }: { args: string[]; stateDir: string }): void {
  assertKnownFlags(args, KRISIS_FLAGS, KRISIS_USAGE);
  const id = positionalId(args, { single: ['--verdict', '--token'], spread: ['--finding'] });
  const verdictIdx = args.indexOf('--verdict');
  const verdict = verdictIdx === -1 ? null : args[verdictIdx + 1];
  const tokenIdx = args.indexOf('--token');
  const token = tokenIdx === -1 ? null : args[tokenIdx + 1];

  const findingIdx = args.indexOf('--finding');
  let finding: string | null = null;
  if (findingIdx !== -1) {
    // Stop at the next flag or the id.
    const words = [];
    for (const word of args.slice(findingIdx + 1)) {
      if (word.startsWith('--') || word === id) break;
      words.push(word);
    }
    finding = words.join(' ') || null;
  }

  if (!id || !verdict) {
    throw new Error(
      `usage: glafka krisis <id> --verdict clean|blocking [--finding "<file:line — what's wrong>"]`,
    );
  }

  // Where this call is coming from. The token proves someone READ the round's prompt; only this
  // proves they are the process that was given it, so a string copied out of a prompt cannot be
  // replayed from elsewhere. With no reviewer process running — the
  // documented manual path — the answer is 'unanswerable' and nothing changes.
  const { origin, detail } = callerRunOrigin({
    stateDir,
    id,
    roles: liveReviewerRoles({ stateDir, id, ticket: readTicket(stateDir, id) }),
  });

  // The value is checked when it is saved, so this cast is only
  // here to keep the compiler happy.
  const findings = appendReviewFinding(stateDir, id, {
    verdict: verdict as ReviewVerdict,
    finding,
    token,
    callerOrigin: origin,
  });
  const recorded = findings[findings.length - 1];
  // A review a person read from the printed brief has no process. The verdict ends it.
  for (const role of reviewerRoles(readTicket(stateDir, id))) {
    markExternalRunFinished({ stateDir, id, role });
  }
  console.log(`${id}  [${verdict}]${finding ? ` ${finding}` : ''}`);
  if (verdict === 'clean' && !recorded.verified) {
    // Two different failures, and telling them apart is the whole point: a
    // wrong token is a mistake, a right token from the wrong place is not.
    console.log(
      token && origin === 'outside'
        ? `  --token matched, but this call did not come from the reviewer it was issued to ` +
            `(${detail}) — recorded, and NOT trusted as a clean verdict`
        : `  no matching --token for this review round — recorded, but not trusted as a clean verdict on its own`,
    );
  }
  console.log(`${findings.length} finding(s) recorded for this review round`);
  console.log(`check the round's outcome: glafka ergon ${id} --review --status`);
}
