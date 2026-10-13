import {
  readTicket,
  appendVerifyResult,
  addCriterionSkip,
  skipReasonLine,
  hashReviewToken,
} from '../../../src/ticket/ticketStore.js';
import { callerRunOrigin, backgroundStatus } from '../../../src/ticket/background.js';
import { appendDecision, DECISION_SOURCE } from '../../../src/ticket/decisions.js';
import { formatVerifyBlock } from '../../../src/commands/epalitheusis/epalitheusis.js';
import { ROLES } from '../../../src/types/ticket.js';
import type { VerifyResultKind } from '../../../src/types/ticket.js';
import { hasTty } from '../cli/tty.js';
import { flagValue, positionalId, assertKnownFlags } from '../cli/args.js';

// Records one QA result for one acceptance criterion, or lets a person skip one.
const FLAGS = ['--ac', '--result', '--evidence', '--token', '--skip', '--reason', '--status'];
const VALUE_FLAGS = ['--ac', '--result', '--evidence', '--token', '--skip', '--reason'];
const USAGE = [
  'usage: glafka epalitheusis <ticket-id> --ac AC-<n> --result pass|fail|cannot --evidence "<command> → <what came back>" [--token <token>]',
  '       glafka epalitheusis <ticket-id> --skip AC-<n> --reason "<why>"   (a person, at a terminal)',
  '       glafka epalitheusis <ticket-id> --status',
].join('\n');

// A person skips one criterion. The skip is written to the ticket's decisions.
function skipCriterion({
  args,
  stateDir,
  id,
  skip,
  hasTty: hasTtyFn,
}: {
  args: string[];
  stateDir: string;
  id: string;
  skip: string;
  hasTty: () => boolean;
}): void {
  // Who is typing decides, like apofasi. A flag an agent can set proves nothing.
  if (!hasTtyFn()) {
    throw new Error(
      `--skip needs a person at a real terminal — an agent cannot skip a criterion.\n` +
        `  record a result instead, or stop: glafka aporia ${id} --reason "..."`,
    );
  }
  // One line, checked before anything is saved: the decisions file takes one line per decision.
  const reason = skipReasonLine(
    flagValue(args, '--reason', '"<why this criterion is skipped>"') ?? '',
  );
  if (reason === '') {
    throw new Error(`--skip needs --reason "<why>" — it is written to the ticket's decisions`);
  }
  addCriterionSkip(stateDir, id, { ac: skip, reason });
  appendDecision(stateDir, id, {
    source: DECISION_SOURCE.PERSON,
    text: `skipped ${skip} in epalitheusis: ${reason}`,
  });
  console.log(`${id}  ${skip} skipped — it is not checked again`);
}

export function runEpalitheusis({
  args,
  stateDir,
  hasTty: hasTtyFn = hasTty,
}: {
  args: string[];
  stateDir: string;
  // Injectable so a test can prove a skip needs a person.
  hasTty?: () => boolean;
}): void {
  assertKnownFlags(args, FLAGS, USAGE);
  const id = positionalId(args, { single: VALUE_FLAGS });
  if (!id) throw new Error(USAGE);

  if (args.includes('--status')) {
    const state = backgroundStatus({ stateDir, id, role: ROLES.VERIFIER }).state;
    for (const line of formatVerifyBlock(readTicket(stateDir, id), state)) console.log(line);
    return;
  }

  const skip = flagValue(args, '--skip', 'an AC id like AC-3');
  if (skip) {
    skipCriterion({ args, stateDir, id, skip, hasTty: hasTtyFn });
    return;
  }

  const ac = flagValue(args, '--ac', 'an AC id like AC-1');
  const result = flagValue(args, '--result', 'pass, fail or cannot');
  if (!ac || !result) throw new Error(USAGE);
  const evidence = flagValue(args, '--evidence', '"<command> → <what came back>"') ?? '';
  const token = flagValue(args, '--token');

  // The token proves someone read the round's prompt; this proves they are the verifier.
  const { origin, detail } = callerRunOrigin({ stateDir, id, roles: [ROLES.VERIFIER] });
  const round = appendVerifyResult(stateDir, id, {
    ac,
    result: result as VerifyResultKind,
    evidence,
    token,
    callerOrigin: origin,
  });
  const entry = round.results[round.results.length - 1]!;
  console.log(`${id}  ${ac} [${entry.result}] ${entry.evidence}`);
  if (entry.result === 'pass' && !entry.verified) {
    console.log(
      token && hashReviewToken(token) === round.token
        ? `  --token matched, but this call did not come from the verifier (${detail}) — NOT trusted as a pass`
        : `  no matching --token for this round — recorded, but NOT trusted as a pass`,
    );
  }
  console.log(`check the round: glafka ergon ${id} --review --status`);
}
