import {
  ergon,
  ergonBackground,
  ergonStatus,
  ergonReview,
  ergonReviewDecide,
  dispatchReviewer,
  type ReviewerAssignment,
  ergonReviewStatus,
  ensureTicketApp,
} from '../../../src/commands/ergon/ergon.js';
import type { ReviewPrepared } from '../../../src/commands/ergon/ergon.js';
import {
  dispatchVerifier,
  openManualRound,
  verifyGate,
  formatVerifyBlock,
  codeFor,
  codeChanges,
  roundCode,
  settleVerifierRun,
  strictLevelWarning,
  type VerifyPrepared,
} from '../../../src/commands/epalitheusis/epalitheusis.js';
import { AUDIT_STAGES } from '../../../src/audit/record.js';
import { ROLES } from '../../../src/types/ticket.js';
import { resolvePolicy } from '../../guardrails/index.js';
import { setReviewerRoles } from '../../../src/ticket/ticketStore.js';
import { resolveAgentCmd, noAgentCmd } from '../../../src/config.js';
import { explainNoChecks } from '../../../src/checks.js';
import {
  listTickets,
  readTicket,
  hasAporia,
  lastRunOutcome,
  pendingCandidates,
  describeTicket,
  reviewerRoles,
  activeCriteria,
  lastReviewQaBlocked,
} from '../../../src/ticket/ticketStore.js';
import { formatPendingListing } from '../../../src/memory/ethosGate.js';
import {
  markExternalRunStarted,
  markExternalRunFinished,
  killBackground,
  backgroundStatus,
  hasPidFile,
} from '../../../src/ticket/background.js';
import { keepArg, assertKnownFlags } from '../cli/args.js';
import { hasTty } from '../cli/tty.js';
import { glafkaCli } from '../../../src/util/cli.js';
import { headTree } from '../../../src/util/git.js';
import { deliverPrompt } from '../agent/deliverPrompt.js';
import { reportGuardrails } from '../agent/guardrailsReport.js';
import type { Config } from '../../../src/types/config.js';
import type { IsolationProfile } from '../../../src/types/isolationProfile.js';
import type { Ticket } from '../../../src/types/ticket.js';

// Says how the agent was told to invoke glafka, but only when that is not the short form. The
// prompt tells it to run `krisis`, `aporia` and `psyche`; when no global `glafka` resolves, glafka
// hands it the vendored absolute path instead (src/util/cli.ts). An agent's own permission
// allowlist is written by hand, and `Bash(glafka:*)` will not match that path — so the verbs would
// be refused, silently, and glafka would report it as "it never called krisis". Naming it here is what lets someone write a rule that matches.
function reportAgentCli(repoRoot: string): void {
  const cli = glafkaCli(repoRoot);
  if (cli === 'glafka') return;
  console.log(
    `  agent CLI: ${cli}  (no global \`glafka\` on PATH — allow this in the agent's own\n` +
      `  permission rules, or it cannot call krisis, aporia or psyche)`,
  );
}

// Shows how the reviewer is doing, and what it has found so far.
async function printReviewStatus({
  args,
  repoRoot,
  stateDir,
  config,
  personaContent,
  profile,
  hasTty: hasTtyFn,
}: {
  args: string[];
  repoRoot: string;
  stateDir: string;
  config: Config;
  personaContent: string | null;
  profile: IsolationProfile | null;
  hasTty: () => boolean;
}): Promise<void> {
  const id = args.find((arg) => !arg.startsWith('--'));
  if (!id) throw new Error('usage: glafka ergon <ticket-id> --review --status');
  // Closes an ended QA round before anything is read. The criteria are step 3, shown below.
  const gate = verifyGate({ stateDir, id, maxRuntimeMs: config.ergonTimeoutMs });
  settleVerifierRun({ stateDir, id, observability: config.observability.enabled });
  const { ticket, status, runs, findings, verdict } = ergonReviewStatus({
    stateDir,
    id,
    maxRuntimeMs: config.ergonTimeoutMs,
    observability: config.observability.enabled,
  });
  // With no reviewer configured there was never a process to start, so `not-started` describes
  // a step that failed to begin — which is what one agent read it as, and stopped on.
  const noReviewer = resolveAgentCmd({ config, role: ROLES.REVIEWER }) === null;
  console.log(`${ticket.id}  review run=${noReviewer ? 'none (no subagent)' : status.state}`);
  if (noReviewer) {
    console.log(
      `  the review is yours to do: glafka ergon ${ticket.id} --review prints the brief,\n` +
        `  then glafka krisis ${ticket.id} --verdict clean|blocking records what you found`,
    );
  }
  for (const run of runs) {
    // A review a person was handed has no process, so there is nothing to kill or report.
    if (run.status.state !== 'timed-out' || !hasPidFile({ stateDir, id, role: run.role })) continue;
    console.log(
      run.killed
        ? `  ${run.role}: killed — still running past ${config.ergonTimeoutMs}ms`
        : `  ${run.role}: past ${config.ergonTimeoutMs}ms and COULD NOT BE KILLED — it may still be running; stop it yourself`,
    );
  }
  if ('logPath' in status) console.log(`log: ${status.logPath}`);
  for (const finding of findings) {
    const unverifiedTag =
      finding.verdict === 'clean' && !finding.verified
        ? ' (unverified — no round token, not trusted alone)'
        : '';
    console.log(
      `  [${finding.verdict}]${finding.finding ? ` ${finding.finding}` : ''}${unverifiedTag}`,
    );
  }

  // Says WHERE the verdict came from. Silence never means clean.
  switch (verdict.source) {
    case 'krisis':
      console.log(`  verdict: ${verdict.verdict}  (via glafka krisis)`);
      break;
    case 'log-line': {
      // "it never called krisis" is only true when nothing was recorded at all. A finding on the
      // ticket can ONLY have come from a krisis call, so printing that line under a list of findings
      // contradicted the four lines above it: the call happened, it was the TRUST that failed —
      // wrong token, or the right token used from outside the reviewer's own process.
      const calledButUntrusted = findings.length > 0;
      console.log(
        `  verdict: ${verdict.verdict}  ` +
          (calledButUntrusted
            ? `(parsed from its own output — it DID call krisis, but no call was trusted)`
            : `(parsed from its own output — it never called krisis)`) +
          (verdict.finding ? `\n  ${verdict.finding}` : ''),
      );
      break;
    }
    case 'none':
      console.log(`  verdict: UNPARSEABLE — it finished but recorded nothing readable either way`);
      console.log(`  read the log yourself: ${'logPath' in status ? status.logPath : null}`);
      break;
    case 'run-failed':
      console.log(`  reviewer process itself ${status.state} — this is not a verdict, see the log`);
      break;
    case 'not-done':
      // Already covered by the run state printed above.
      break;
  }

  // Step 3: the acceptance criteria, checked only after a recorded clean review of this code.
  if (gate.kind === 'skip') return;
  const current = readTicket(stateDir, id);
  if (current.verification) {
    const runState = backgroundStatus({ stateDir, id, role: ROLES.VERIFIER }).state;
    for (const line of formatVerifyBlock(current, runState)) console.log(line);
  }
  if (verdict.verdict !== 'clean' || verdict.source !== 'krisis') return;
  // A clean verdict on older code says nothing about this code.
  if (!current.worktree || current.reviewedTree !== headTree(current.worktree)) {
    console.log(
      `  the code changed since the clean review — start the review: glafka ergon ${id} --review`,
    );
    return;
  }
  if (gate.kind === 'passed') {
    console.log(`  all acceptance criteria passed — ready`);
    return;
  }
  if (gate.kind === 'blocked' && gate.outcome === 'failed') {
    // A committed fix gets a new review, then a new QA round. Uncommitted edits do not.
    console.log(`  fix the failed criteria and commit, then run: glafka ergon ${id} --review`);
    return;
  }
  // A pass on uncommitted changes: not done until they are committed.
  if (gate.kind === 'blocked' && gate.outcome === 'passed') console.log(`  ${gate.detail}`);
  if (gate.kind !== 'start') return;
  // A round on this code already ended and was acted on. Only a person starts the next one.
  if (lastReviewQaBlocked(current)) {
    // A new round is due for one of two reasons. Say the true one.
    const round = current.verification;
    const changed =
      round !== null && codeChanges(roundCode(round), codeFor(round, current.worktree)).length > 0;
    console.log(
      changed
        ? `  the code changed since this round — glafka ergon ${id} --review starts a new one`
        : `  this round's outcome was already acted on — glafka ergon ${id} --review starts a new one`,
    );
    return;
  }
  console.log(`  review clean — starting the QA round`);
  return runReviewRound({
    args: [id],
    repoRoot,
    stateDir,
    config,
    personaContent,
    profile,
    hasTty: hasTtyFn,
  });
}

// A person decides which findings to keep. It does not review again.
function decideReviewCandidates({
  args,
  repoRoot,
  stateDir,
}: {
  args: string[];
  repoRoot: string;
  stateDir: string;
}): void {
  const id = args.find((arg) => !arg.startsWith('--'));
  if (!id) throw new Error('usage: glafka ergon <ticket-id> --review --keep all|none|1,3');
  const keep = keepArg(args);
  const { kept, decided } = ergonReviewDecide({ repoRoot, stateDir, id, keep });
  for (const candidate of kept) console.log(`kept  [${candidate.target}] ${candidate.text}`);
  console.log(`${id}  ${kept.length}/${decided} candidate(s) kept, the rest discarded`);
  if (kept.length > 0) console.log(`written to docs/glafka/ethos/ under ## Learned`);
}

// Starts a reviewer process and prints its process id. Starts every reviewer this round earned. They
// read the same committed diff and hold no worktree, branch or port, so they run side by side.
function startReviewers({
  ticket,
  reviewers,
  routeNote,
  reviewerCmd,
  repoRoot,
  stateDir,
}: {
  ticket: Ticket;
  reviewers: ReviewerAssignment[];
  routeNote: string;
  reviewerCmd: string;
  repoRoot: string;
  stateDir: string;
}): void {
  const { policy } = resolvePolicy({ repoRoot });
  console.log(`${ticket.id}  ${routeNote}`);

  // Recorded BEFORE the spawns, not after. A role with no run yet reads as `not-started`, which
  // every liveness guard already allows through — while a role that IS running and is not on the
  // list is invisible to all of them. The unsafe order was the other one.
  setReviewerRoles(
    stateDir,
    ticket.id,
    reviewers.map((r) => r.role),
  );

  // Every reviewer runs under the same policy, so one report covers them.
  let firstGuardrails: Parameters<typeof reportGuardrails>[1] | null = null;
  for (const reviewer of reviewers) {
    // Only this path reaches a separate process, so only this prompt
    // carries the review token.
    const { pid, guardrails } = dispatchReviewer({
      stateDir,
      ticket,
      prompt: reviewer.reviewerPrompt,
      agentCmd: reviewerCmd,
      policy,
      role: reviewer.role,
    });
    firstGuardrails ??= guardrails;
    console.log(`${ticket.id}  ${reviewer.kind} reviewer started (pid ${pid})`);
  }

  // One line for the round, not one per reviewer — they share a policy.
  if (firstGuardrails) reportGuardrails(policy, firstGuardrails, ticket.guardrails?.widened);
  reportAgentCli(repoRoot);
  console.log(`check progress: glafka ergon ${ticket.id} --review --status`);
}

async function printReviewBrief({
  ticket,
  prompt,
  reviewToken,
  repoRoot,
  stateDir,
  config,
  hasTty: hasTtyFn,
}: {
  ticket: Ticket;
  prompt: string;
  reviewToken: string;
  repoRoot: string;
  stateDir: string;
  config: Pick<Config, 'agents' | 'observability'>;
  hasTty: () => boolean;
}): Promise<void> {
  // Notes go to the error stream and the prompt to the output stream,
  // so the output can be piped into another tool.
  console.error(`--- ${ticket.id}  ${ticket.worktree} ---`);
  const { policy } = resolvePolicy({ repoRoot });
  // On an AC ticket the person reading this is the reviewer: marked started, so --status does not
  // send them back for a new token. A ticket with no AC stays exactly as it was.
  const current = readTicket(stateDir, ticket.id);
  if (current.verification || activeCriteria(current).length > 0) {
    markExternalRunStarted({ stateDir, id: ticket.id, role: ROLES.REVIEWER, prompt });
  }
  await deliverPrompt(prompt, {
    cwd: ticket.worktree,
    policy,
    stateDir,
    agentCmd: resolveAgentCmd({ config, role: ROLES.REVIEWER }),
    ticketId: ticket.id,
    stage: AUDIT_STAGES.REVIEW,
    role: ROLES.REVIEWER,
    observability: config.observability.enabled,
  });

  // The round token, on STDERR only. This is the documented manual path: the prompt on stdout stays
  // token-free — the coder never sees this, because the coder is not the
  // one reading the terminal. Without it a human review could never produce a pushable verdict, and
  // epistle's only route was --unreviewed.
  console.error(`\n--- ${ticket.id}: you have read this diff. Record your verdict ---`);
  // No terminal means an agent's shell, and here that agent is the coder.
  // So the clean token is shown only to a person, like the manual QA round.
  if (hasTtyFn()) {
    console.error(`  clean:    glafka krisis ${ticket.id} --verdict clean --token ${reviewToken}`);
  } else {
    console.error(
      `  clean:    a person runs glafka ergon ${ticket.id} --review at a real terminal`,
    );
  }
  console.error(
    `  blocking: glafka krisis ${ticket.id} --verdict blocking --finding "<file:line — what's wrong>"`,
  );

  // Read again, since the reviewer may have added rules while it ran.
  const pending = pendingCandidates(readTicket(stateDir, ticket.id));
  if (pending.length === 0) return;
  console.error(
    `\n--- ${ticket.id}: ${pending.length} ethos candidate(s) awaiting your decision ---`,
  );
  console.error(formatPendingListing(pending));
  console.error(`\nkeep all:  glafka ergon ${ticket.id} --review --keep all`);
  console.error(`keep some: glafka ergon ${ticket.id} --review --keep 1,3`);
  console.error(`keep none: glafka ergon ${ticket.id} --review --keep none`);
}

// Starts the QA tester. Only this path reaches a separate process, so only it gets the token.
function startVerifier({
  ticket,
  verify,
  verifierCmd,
  repoRoot,
  stateDir,
}: {
  ticket: Ticket;
  verify: VerifyPrepared;
  verifierCmd: string;
  repoRoot: string;
  stateDir: string;
}): void {
  const { policy } = resolvePolicy({ repoRoot });
  const { pid, guardrails } = dispatchVerifier({
    stateDir,
    ticket,
    verify,
    agentCmd: verifierCmd,
    policy,
  });
  console.log(
    `${ticket.id}  ${verify.criteria.length} acceptance criteria — QA tester started (pid ${pid})`,
  );
  reportGuardrails(policy, guardrails, ticket.guardrails?.widened);
  reportAgentCli(repoRoot);
  console.log(`check progress: glafka ergon ${ticket.id} --review --status`);
}

// No verifier agent: a person checks the AC. The brief goes on stdout, the token on stderr.
// False when nothing could start: no terminal, so no token and no round.
function printVerifyBrief({
  ticket,
  verify,
  stateDir,
  hasTty: hasTtyFn,
}: {
  ticket: Ticket;
  verify: VerifyPrepared;
  stateDir: string;
  hasTty: () => boolean;
}): boolean {
  // The token is the proof of a real pass. An agent's shell has no terminal, and in this flow
  // that agent is the coder. So no token and no round: the person's own run opens one.
  if (!hasTtyFn()) {
    console.error(
      `--- ${ticket.id}: the acceptance criteria need a QA tester, and none is configured ---\n` +
        `  a person must run this at a real terminal, to get this round's token:\n` +
        `    glafka ergon ${ticket.id} --review\n` +
        `  or set "agents": { "verifier": "…" } in .glafka.json (glafka install sets one up).\n` +
        `  nothing was started. Stop here and hand this ticket to that person.`,
    );
    return false;
  }
  openManualRound({ stateDir, ticket, verify });
  console.error(`--- ${ticket.id}  ${ticket.worktree} ---`);
  console.log(verify.prompt);
  const record = `glafka epalitheusis ${ticket.id} --ac <AC-n>`;
  console.error(`\n--- ${ticket.id}: check each criterion, then record it ---`);
  console.error(
    `  pass:   ${record} --result pass --evidence "<command> → <what came back>" --token ${verify.token}`,
  );
  console.error(`  fail:   ${record} --result fail --evidence "<what you saw>"`);
  console.error(`  cannot: ${record} --result cannot --evidence "<why>"`);
  console.error(`then: glafka ergon ${ticket.id} --review --status`);
  return true;
}

// One ticket's QA round. False when nothing started; a failure is said against this ticket only.
async function startQaRound({
  round: { ticket, verify, routeNote },
  verifierCmd,
  repoRoot,
  stateDir,
  hasTty: hasTtyFn,
}: {
  round: ReviewPrepared & { verify: VerifyPrepared };
  verifierCmd: string | null;
  repoRoot: string;
  stateDir: string;
  hasTty: () => boolean;
}): Promise<boolean> {
  console.log(`${ticket.id}  ${routeNote}`);
  const strict = strictLevelWarning(repoRoot);
  if (strict) console.error(`warning: ${ticket.id}  ${strict}`);
  // No tester and no terminal: the handover says who must run it. Nothing opens.
  if (!verifierCmd && !hasTtyFn())
    return printVerifyBrief({ ticket, verify, stateDir, hasTty: hasTtyFn });
  try {
    // The tester cannot restart the app itself, so it must be up before a round opens.
    await ensureTicketApp({ stateDir, repoRoot, ticket });
    if (verifierCmd) startVerifier({ ticket, verify, verifierCmd, repoRoot, stateDir });
    else printVerifyBrief({ ticket, verify, stateDir, hasTty: hasTtyFn });
    return true;
  } catch (err) {
    console.error(`${ticket.id}  the QA round could not start: ${(err as Error).message}`);
    return false;
  }
}

type ReviewOutcome =
  { ok: true; id: string; result: ReviewPrepared } | { ok: false; id: string; err: Error };

// The final step. Leave out the id to review every open ticket.
async function runReviewRound({
  args,
  repoRoot,
  stateDir,
  config,
  personaContent,
  profile,
  hasTty: hasTtyFn = hasTty,
}: {
  args: string[];
  repoRoot: string;
  stateDir: string;
  config: Config;
  personaContent: string | null;
  profile: IsolationProfile | null;
  hasTty?: () => boolean;
}): Promise<void> {
  const id = args.find((arg) => !arg.startsWith('--'));
  const ticketIds = id ? [id] : listTickets(stateDir).map((t) => t.id);
  // Only for one named ticket: a sweep must not throw away a person's open manual rounds.
  const restartManualRound = Boolean(id) && hasTtyFn();

  // An ended QA tester run is recorded before a new one can replace its files.
  for (const ticketId of ticketIds) {
    settleVerifierRun({ stateDir, id: ticketId, observability: config.observability.enabled });
  }

  // One ticket failing must never stop the others.
  const prepareReview = (ticketId: string): Promise<ReviewOutcome> =>
    ergonReview({
      stateDir,
      id: ticketId,
      repoRoot,
      restartManualRound,
      baseRef: config.baseRef ?? undefined,
      checksCmd: config.checksCmd,
      e2eCmd: config.e2eCmd,
      checksTimeoutMs: config.checksTimeoutMs,
      e2eTimeoutMs: config.e2eTimeoutMs,
      reviewDoc: config.reviewDoc,
      personaContent,
    }).then(
      (result): ReviewOutcome => ({ ok: true, id: ticketId, result }),
      (err: Error): ReviewOutcome => ({ ok: false, id: ticketId, err }),
    );

  // Run several at once only when each ticket has its own port and database.
  const canOverlap = ticketIds.length > 1 && profile !== null;
  let outcomes: ReviewOutcome[];
  if (canOverlap) {
    outcomes = await Promise.all(ticketIds.map(prepareReview));
  } else {
    outcomes = [];
    for (const ticketId of ticketIds) outcomes.push(await prepareReview(ticketId));
  }

  const prepared: ReviewPrepared[] = [];
  let failed = 0;
  for (const outcome of outcomes) {
    // We test for the field, not the boolean, because type narrowing
    // is not reliable with this tsconfig.
    if ('result' in outcome) {
      prepared.push(outcome.result);
    } else {
      failed += 1;
      console.error(`${outcome.id}  review preparation failed: ${outcome.err.message}`);
    }
  }

  // Errors are caught per ticket on purpose — over a whole queue, one bad ticket must not stop the
  // rest. But that swallowed the exit code too, so a run where NOTHING could be reviewed still
  // exited 0, and any script or timer driving this read a refusal as "review under way". A partial
  // batch stays 0: some reviews really did start.
  if (failed > 0 && prepared.length === 0) process.exitCode = 1;

  // With no reviewer command set, we just print the prompt instead.
  const reviewerCmd = resolveAgentCmd({ config, role: ROLES.REVIEWER });
  const verifierCmd = resolveAgentCmd({ config, role: ROLES.VERIFIER });

  let qaNotStarted = 0;
  for (const round of prepared) {
    const { ticket, prompt, reviewers, routeNote, reviewToken, verify } = round;
    // A clean review left the acceptance criteria: a QA tester checks them on the same code.
    if (verify) {
      const qaRound = { ...round, verify };
      const args = { round: qaRound, verifierCmd, repoRoot, stateDir, hasTty: hasTtyFn };
      if (!(await startQaRound(args))) qaNotStarted += 1;
      continue;
    }
    if (reviewerCmd) {
      startReviewers({ ticket, reviewers, routeNote, reviewerCmd, repoRoot, stateDir });
    } else {
      // No reviewer agent configured, so a person is going to paste this. One prompt, not several: the
      // extra reviewers only pay off when something else runs them.
      console.log(`${ticket.id}  ${routeNote}`);
      const brief = { ticket, prompt, reviewToken, repoRoot, stateDir, config, hasTty: hasTtyFn };
      await printReviewBrief(brief);
    }
  }
  // The same rule as above: a script must not read "nothing started anywhere" as under way.
  if (qaNotStarted > 0 && failed + qaNotStarted === outcomes.length) process.exitCode = 1;
}

// Looks at a background run, and runs the real checks.
async function printTicketStatus({
  id,
  repoRoot,
  stateDir,
  config,
}: {
  id: string;
  repoRoot: string;
  stateDir: string;
  config: Config;
}): Promise<void> {
  const { ticket, status, checks, progress, killed, justRan } = await ergonStatus({
    stateDir,
    id,
    repoRoot,
    baseRef: config.baseRef ?? undefined,
    checksCmd: config.checksCmd,
    e2eCmd: config.e2eCmd,
    checksTimeoutMs: config.checksTimeoutMs,
    e2eTimeoutMs: config.e2eTimeoutMs,
    maxRuntimeMs: config.ergonTimeoutMs,
    observability: config.observability.enabled,
  });
  console.log(`${ticket.id}  ${describeTicket(ticket)}  run=${status.state}`);
  // Tells a coder that stopped on purpose apart from one that finished.
  if (hasAporia(ticket)) {
    console.log(`  ⚠ ATTENTION NEEDED — the coder recorded an impasse:`);
    console.log(`  ${ticket.aporia?.reason}`);
  }
  if (status.state === 'timed-out') {
    console.log(
      killed
        ? `  killed: still running past ${config.ergonTimeoutMs}ms, recorded as ${lastRunOutcome(ticket)}`
        : `  ⚠ past ${config.ergonTimeoutMs}ms and COULD NOT BE KILLED — recorded as ` +
            `${lastRunOutcome(ticket)}, but the process may still be running and spending money.\n` +
            `  stop it yourself, then re-run this command.`,
    );
  }
  if (progress) {
    console.log(`  ${progress.commits} commit(s) since plan approval`);
    if (progress.latestCommit) console.log(`  latest: "${progress.latestCommit}"`);
    if (progress.uncommittedChanges) {
      console.log(`  uncommitted changes present — a step may have been interrupted mid-way`);
    }
  }
  if ('logPath' in status) console.log(`log: ${status.logPath}`);
  // Which tree the checks below actually read. `runChecks` runs in the worktree, uncommitted edits
  // included; the review reads `git diff base...HEAD`. A coder that wrote correct code and
  // committed none of it therefore gets a green check on work the reviewer will never see, and
  // `PASSED` sitting under `0 commit(s)` said the opposite of the truth. The
  // result is right; only the label was missing.
  const coversNothingReviewable = progress != null && progress.commits === 0;
  const scope = progress?.uncommittedChanges
    ? ` (working tree, including uncommitted changes — the review reads the committed diff)`
    : '';
  for (const check of checks) {
    // A check that printed too much is UNVERIFIED, never FAILED.
    const label = check.passed ? 'PASSED' : check.unknown ? 'UNVERIFIED' : 'FAILED';
    console.log(`  ${check.name}: ${label}${check.passed ? scope : ''}`);
    if (check.unknown) console.log(`    ${check.output.split('\n')[0]}`);
  }
  // "Just checking status" ran the real checks and recorded the answer — this call moved
  // `epistle`'s gate, it did not just report on it. Said out loud because it used to be invisible: a
  // ticket whose outcome had never been recorded would get one recorded by whatever asked about it
  // next, silently, and a later `epistle` call would behave differently with nothing having changed
  // on purpose in between.
  if (justRan) {
    console.log(
      `  (checks just ran and were recorded as this ticket's outcome — not a cached read)`,
    );
  }
  if (coversNothingReviewable && checks.some((c) => c.passed)) {
    console.log(
      `  ⚠ nothing is committed on this branch, so the check above proves nothing about this ticket.`,
    );
  }
  // Say it loudly when no checks ran, so nobody reads it as a pass.
  if (status.state === 'finished' && checks.length === 0) {
    console.log(`  ⚠ checks: UNVERIFIED — nothing ran, so this cannot be pushed`);
    console.log(`  ${explainNoChecks(ticket.worktree)}`);
  }
}

// Runs on its own, and keeps going after this command exits.
async function runInBackground({
  id,
  repoRoot,
  stateDir,
  config,
  personaContent,
}: {
  id: string;
  repoRoot: string;
  stateDir: string;
  config: Config;
  personaContent: string | null;
}): Promise<void> {
  // Same resolver every other spawn uses, so `.glafka.json` and the env var
  // cannot disagree about where the coder is configured.
  const agentCmd = resolveAgentCmd({ config, role: ROLES.CODER });
  if (!agentCmd) throw new Error(noAgentCmd('--background'));
  const { policy } = resolvePolicy({ repoRoot });
  const { ticket, pid, guardrails } = await ergonBackground({
    stateDir,
    id,
    repoRoot,
    agentCmd,
    policy,
    checksCmd: config.checksCmd,
    e2eCmd: config.e2eCmd,
    personaContent,
  });
  console.log(`${ticket.id}  started in background (pid ${pid})`);
  reportGuardrails(policy, guardrails, ticket.guardrails?.widened);
  reportAgentCli(repoRoot);
  console.log(`check progress: glafka ergon ${ticket.id} --status`);
}

// The default: print the coder's prompt, or send it to the agent command.
async function runInteractive({
  id,
  repoRoot,
  stateDir,
  config,
  personaContent,
}: {
  id: string;
  repoRoot: string;
  stateDir: string;
  config: Config;
  personaContent: string | null;
}): Promise<void> {
  const { ticket, prompt } = await ergon({
    stateDir,
    id,
    repoRoot,
    baseRef: config.baseRef ?? undefined,
    checksCmd: config.checksCmd,
    e2eCmd: config.e2eCmd,
    personaContent,
  });
  console.error(`--- ${ticket.id} ---`);
  const { policy } = resolvePolicy({ repoRoot });
  // Stamped BEFORE handing the prompt off, whether or not GLAFKA_AGENT_CMD is set: with none set, this call is about to print and exit, and the
  const coderCmd = resolveAgentCmd({ config, role: ROLES.CODER });
  // The prompt and the agent are saved with the run, the same as a spawned
  // one, so the audit is not left guessing what was handed out or to what.
  markExternalRunStarted({
    stateDir,
    id: ticket.id,
    role: ROLES.CODER,
    prompt,
    agentCmd: coderCmd,
  });
  await deliverPrompt(prompt, {
    cwd: ticket.worktree,
    policy,
    stateDir,
    agentCmd: coderCmd,
    // Not `cwd` — that is the worktree. The session reading the handover runs here.
    repoRoot,
    ticketId: ticket.id,
    stage: AUDIT_STAGES.ERGON,
    role: ROLES.CODER,
    observability: config.observability.enabled,
  });
}

// The terminator for a run glafka does not own. `--review` and `aporia` cover the two endings the
// prompt asks for. This is the third case: a coder that stopped for any other reason, or a human
// clearing a run whose agent went away. Without it the only way out was to wait for something else
// to overwrite the marker.
function markCoderDone({ id, stateDir }: { id: string; stateDir: string }): void {
  // Fail loudly on a bad id, the same as every other verb here.
  readTicket(stateDir, id);
  const ended = markExternalRunFinished({ stateDir, id, role: ROLES.CODER });
  if (ended) {
    console.log(`${id}  coder run marked finished`);
    return;
  }
  // Says WHICH of the three reasons it was, because "nothing happened" with
  // no explanation is what sent someone looking at the marker by hand.
  console.log(
    `${id}  nothing to mark — either no coder run was dispatched, it already ended, ` +
      `or glafka spawned it itself (that run's own exit code is what counts; ` +
      `check \`glafka ergon ${id} --status\`)`,
  );
}

// Stops a run you started, and records it as YOUR stop. A hand `kill` leaves
// the same evidence a crash does, so poreia reported it as `crashed`.
function stopRuns({ args, stateDir }: { args: string[]; stateDir: string }): void {
  const id = args.find((arg) => !arg.startsWith('--'));
  if (!id) {
    throw new Error(
      'usage: glafka ergon <ticket-id> --stop            stop the coder\n' +
        "       glafka ergon <ticket-id> --review --stop  stop this round's reviewers and QA tester",
    );
  }
  // Fail loudly on a bad id, the same as every other verb here.
  const ticket = readTicket(stateDir, id);
  // The reviewers are a round, so every role this round started is stopped —
  // stopping one of two leaves the round open on the other for good.
  const roles = args.includes('--review')
    ? [...reviewerRoles(ticket), ROLES.VERIFIER]
    : [ROLES.CODER];

  const stopped = roles.filter((role) => killBackground({ stateDir, id, role }));
  if (stopped.length === 0) {
    console.log(
      `${id}  nothing to stop — no ${args.includes('--review') ? 'reviewer or QA tester' : 'coder'} run of ` +
        `glafka's own is alive right now (a run you dispatched yourself is not glafka's to signal).`,
    );
    return;
  }
  console.log(`${id}  stopped: ${stopped.join(', ')}`);
  console.log(`  recorded as stopped by you, not as a crash — glafka poreia ${id}`);
}

// Every flag `runErgon` reads. The list is here, next to the dispatch that
// reads it, so the two cannot drift.
const ERGON_FLAGS = ['--review', '--status', '--background', '--finished', '--keep', '--stop'];

const ERGON_USAGE = [
  'usage: glafka ergon <ticket-id>                     print the coder prompt for your own session',
  '       glafka ergon <ticket-id> --background        run the coder as its own process',
  '       glafka ergon <ticket-id> --status            how far the coder got, and the checks',
  '       glafka ergon <ticket-id> --finished          mark a coder you dispatched yourself as done',
  '       glafka ergon <ticket-id> --review            run the checks and dispatch a fresh reviewer',
  '       glafka ergon <ticket-id> --review --status   how the review went',
  '       glafka ergon <ticket-id> --review --keep all|none|1,3   rule on recorded conventions',
  '       glafka ergon <ticket-id> --stop              stop the coder you started',
  "       glafka ergon <ticket-id> --review --stop     stop this round's reviewers and QA tester",
].join('\n');

export async function runErgon({
  args,
  repoRoot,
  stateDir,
  config,
  personaContent,
  profile,
  hasTty: hasTtyFn = hasTty,
}: {
  args: string[];
  repoRoot: string;
  stateDir: string;
  config: Config;
  personaContent: string | null;
  profile: IsolationProfile | null;
  // Injectable so a test can prove the QA token needs a person at a terminal.
  hasTty?: () => boolean;
}): Promise<void> {
  // Before any dispatch, because the fall-through below is a real mode that
  // changes ticket state.
  assertKnownFlags(args, ERGON_FLAGS, ERGON_USAGE);

  // Check the most exact flag combinations first.
  if (args.includes('--stop')) return stopRuns({ args, stateDir });
  if (args.includes('--review') && args.includes('--status')) {
    return printReviewStatus({
      args,
      repoRoot,
      stateDir,
      config,
      personaContent,
      profile,
      hasTty: hasTtyFn,
    });
  }
  if (args.includes('--review') && keepArg(args) !== null) {
    return decideReviewCandidates({ args, repoRoot, stateDir });
  }
  if (args.includes('--review')) {
    return runReviewRound({
      args,
      repoRoot,
      stateDir,
      config,
      personaContent,
      profile,
      hasTty: hasTtyFn,
    });
  }

  const id = args.find((arg) => !arg.startsWith('--'));
  if (!id) throw new Error('usage: glafka ergon <ticket-id> [--status|--background|--finished]');
  if (args.includes('--finished')) return markCoderDone({ id, stateDir });
  if (args.includes('--status')) return printTicketStatus({ id, repoRoot, stateDir, config });
  if (args.includes('--background'))
    return runInBackground({ id, repoRoot, stateDir, config, personaContent });
  return runInteractive({ id, repoRoot, stateDir, config, personaContent });
}
