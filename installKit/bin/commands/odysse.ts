import {
  odysse,
  odysseChecks,
  odysseDecide,
  odysseWorkspaceDecide,
  odysseFollowUp,
  readWorkspaceProposalListing,
} from '../../../src/commands/odysse/odysse.js';
import type { CbmFns } from '../../../src/commands/odysse/odysse.js';
import { checksFromFiles, proposeChecks } from '../../../src/commands/odysse/checksFromFiles.js';
import { waitForCodeGraph } from '../../../src/commands/install/codeGraph.js';
import { readProposals, proposeEthos } from '../../../src/memory/ethos.js';
import { AUDIT_STAGES } from '../../../src/audit/record.js';
import { ROLES } from '../../../src/types/ticket.js';
import { loadCategories, flagsOf } from '../../../src/memory/categories.js';
import { formatPendingListing, parseKeepArg } from '../../../src/memory/ethosGate.js';
import { DOCS_ROOT, writeArchitectureStamp } from '../../../src/memory/docsStore.js';
import { headCommit, refExists } from '../../../src/util/git.js';
import {
  rulesInForce,
  applyAudit,
  readAuditProposals,
  clearAuditProposals,
  assertAuditDecidable,
  writeAuditWatermark,
} from '../../../src/memory/ethosAudit/ethosAudit.js';
import { runAuditPass } from '../../../src/memory/ethosAudit/runPass.js';
import { flagValue, keepArg, assertKnownFlags } from '../cli/args.js';
import { hasTty } from '../cli/tty.js';
import { deliverPrompt } from '../agent/deliverPrompt.js';
import { standardsInstalled } from '../../../src/memory/standards.js';
import { resolvePolicy } from '../../guardrails/index.js';
import { resolveAgentCmd } from '../../../src/config.js';
import { runChecks } from '../../../src/checks.js';
import type { Config } from '../../../src/types/config.js';

// Every flag this command reads. Anything else is a typo, and a typo used to be silently ignored —
// sometimes into a different action entirely.
export const ODYSSE_FLAGS = [
  '--compact',
  // Kept for one release so an existing script does not break in silence.
  '--audit',
  '--checks',
  '--list',
  '--propose',
  '--keep',
  '--workspace-keep',
];
export const ODYSSE_USAGE =
  'usage: glafka odysse                    scan the whole codebase\n       glafka odysse --checks           find how this project verifies itself\n       glafka odysse --list|--compact|--propose|--keep|--workspace-keep';

// What to say under a listing. A person at a terminal can type the command. An agent
// cannot hand one to a person — it has to ask them, then run the command itself.
function decisionFooter(flag: string, atTty: boolean): string {
  if (atTty) {
    return (
      `\nkeep all:  glafka odysse ${flag} all` +
      `\nkeep some: glafka odysse ${flag} 1,3` +
      `\nkeep none: glafka odysse ${flag} none`
    );
  }
  return (
    `\nAsk the person which of these to keep. Offer them as options to pick from,` +
    `\none question per category, in their own words. Do not show them this list,` +
    `\nand do not give them a command to run — you run it:` +
    `\n  glafka odysse ${flag} <the ones they picked>`
  );
}

export async function runOdysse({
  args,
  repoRoot,
  stateDir,
  config,
  hasTty: hasTtyFn = hasTty,
  cbm,
}: {
  args: string[];
  repoRoot: string;
  stateDir: string;
  config: Pick<Config, 'agents' | 'observability' | 'checksTimeoutMs'>;
  // Injectable so a test can prove both audiences get the right text.
  hasTty?: () => boolean;
  cbm?: CbmFns;
}): Promise<void> {
  const atTty = hasTtyFn();
  // The category flags come from the project, so the allowlist is built from them too.
  // A hardcoded list rejected `--propose --code` before it ever reached recordProposal.
  assertKnownFlags(
    args,
    [...ODYSSE_FLAGS, ...Object.keys(flagsOf(loadCategories(repoRoot)))],
    ODYSSE_USAGE,
  );
  // Shows the current findings, without scanning again.
  function printPendingListing() {
    const proposals = readProposals(repoRoot);
    const workspace = readWorkspaceProposalListing(repoRoot);
    if (proposals.length > 0) {
      console.log(`--- ${proposals.length} convention(s) observed, awaiting your decision ---`);
      console.log(formatPendingListing(proposals));
      console.log(decisionFooter('--keep', atTty));
    } else {
      console.log('no conventions pending');
    }
    if (workspace.length > 0) {
      console.log(
        `\n--- ${workspace.length} workspace setting(s) proposed, awaiting your decision ---`,
      );
      console.log(workspace.map((label, i) => `  ${i + 1}. ${label}`).join('\n'));
      console.log(decisionFooter('--workspace-keep', atTty));
    } else {
      console.log('no workspace settings pending');
    }
  }

  // package.json first: no agent, no wait. A small agent, separate from the full scan, otherwise.
  async function runChecksScan() {
    const found = checksFromFiles(repoRoot);
    if (found) {
      proposeChecks(repoRoot, found);
      console.error('odysse: found in package.json, no agent needed');
      const proposed = readWorkspaceProposalListing(repoRoot);
      console.error(
        `\n--- ${proposed.length} workspace setting(s) proposed, awaiting your decision ---`,
      );
      console.error(proposed.map((label, i) => `  ${i + 1}. ${label}`).join('\n'));
      console.error(decisionFooter('--workspace-keep', atTty));
      return;
    }
    const { prompt } = odysseChecks({ repoRoot });
    const { policy } = resolvePolicy({ repoRoot });
    const ranAgent = await deliverPrompt(prompt, {
      cwd: repoRoot,
      policy,
      stateDir,
      agentCmd: resolveAgentCmd({ config, role: ROLES.REPORTER }),
      ticketId: null,
      stage: AUDIT_STAGES.ODYSSE,
      role: ROLES.REPORTER,
      observability: config.observability.enabled,
    });

    // Read the results only after the agent ran, or we would show old ones.
    const { workspace: proposed } = odysseFollowUp({ repoRoot, ranAgent });
    if (proposed.length > 0) {
      console.error(
        `\n--- ${proposed.length} workspace setting(s) proposed, awaiting your decision ---`,
      );
      console.error(proposed.map((label, i) => `  ${i + 1}. ${label}`).join('\n'));
      console.error(decisionFooter('--workspace-keep', atTty));
    } else if (!ranAgent) {
      console.error(
        `\nOnce workspace.proposed.json is written, ` + `see what's pending: glafka odysse --list`,
      );
    }
  }

  // Same as --keep, but for workspace settings.
  async function applyWorkspaceKeep(workspaceKeep: string): Promise<void> {
    const { applied, decided, keptChecksCmd } = odysseWorkspaceDecide({
      repoRoot,
      keep: workspaceKeep,
    });
    for (const label of applied) console.log(`applied  ${label}`);
    console.log(
      applied.length > 0
        ? `${applied.length} workspace setting(s) written to isolation.json`
        : 'no workspace settings kept',
    );
    // The gate is one-shot, so say where a wrong pick can be read back from.
    if (decided > applied.length) {
      console.log(`the rest are kept in ${DOCS_ROOT}/architecture/workspace.decided.json`);
    }
    if (keptChecksCmd) await testKeptChecks(keptChecksCmd);
  }

  // The agent only found this command; a person kept it. So glafka runs it once, to show if it works.
  // Only at a real terminal: an agent must not get a way to run a command it wrote itself.
  async function testKeptChecks(checksCmd: string): Promise<void> {
    if (!atTty) {
      console.log(
        'checks command not tested: glafka tests it only for a person at a real terminal.',
      );
      console.log('  to test it on a ticket: glafka checks <ticket-id>');
      return;
    }
    console.log(`testing the checks command now: ${checksCmd}`);
    const timeout = config.checksTimeoutMs;
    const [result] = await runChecks(repoRoot, { checksCmd, checksTimeoutMs: timeout });
    if (result?.passed) return console.log('checks passed');
    console.log(
      result?.unknown
        ? 'checks: the result is unknown'
        : 'checks FAILED. Saved anyway: the project itself may be broken right now.',
    );
    console.log((result?.output ?? '').trimEnd().split('\n').slice(-20).join('\n'));
    console.log(
      `  wrong command? change workspace.checksCmd in ${DOCS_ROOT}/architecture/isolation.json`,
    );
  }

  // A person picks what to keep from the scan.
  function applyConventionKeep(keep: string): void {
    const { kept, decided } = odysseDecide({ repoRoot, keep });
    for (const candidate of kept) console.log(`kept  [${candidate.target}] ${candidate.text}`);
    console.log(`${kept.length}/${decided} observation(s) kept, the rest dropped`);
    if (decided > kept.length) {
      console.log(
        `the rest are under ## Dropped in ${DOCS_ROOT}/ethos/ — move one back up if wrong`,
      );
    }
  }

  async function runFullScan() {
    // Install starts the code map tool's download in the background; the map needs it.
    const downloadFailed = cbm ? null : await waitForCodeGraph();
    if (downloadFailed) {
      console.error(`odysse: the code map download failed (${downloadFailed})`);
    }
    const result = odysse({ repoRoot, cbm });

    if (result.cbmIndexed) {
      if (refExists(repoRoot, 'HEAD')) {
        writeArchitectureStamp(repoRoot, headCommit(repoRoot));
      }
      console.error('\nodysse: indexed by codebase-memory-mcp');
      return;
    }
    if (result.cbmError) {
      console.error(
        `odysse: the code graph failed (${result.cbmError}), so an agent writes the map`,
      );
    }

    const { policy } = resolvePolicy({ repoRoot });
    const ranAgent = await deliverPrompt(result.prompt, {
      cwd: repoRoot,
      policy,
      stateDir,
      agentCmd: resolveAgentCmd({ config, role: ROLES.REPORTER }),
      ticketId: null,
      stage: AUDIT_STAGES.ODYSSE,
      role: ROLES.REPORTER,
      observability: config.observability.enabled,
    });

    // Read the results only after the agent ran, or we would show old ones.
    const { proposals, workspace, docsWritten, isolationWritten } = odysseFollowUp({
      repoRoot,
      ranAgent,
    });

    // Only when glafka itself ran the agent and docs came out of it. A repo
    // with no commits has no HEAD, and headCommit would throw on the scan.
    if (ranAgent && docsWritten > 0 && refExists(repoRoot, 'HEAD')) {
      writeArchitectureStamp(repoRoot, headCommit(repoRoot));
    }

    // glafka states the outcome itself, off disk. The prompt tells the agent not to
    // write its own version, so this is the only place the run gets reported.
    if (ranAgent) {
      console.error(`\nodysse: ${docsWritten} doc(s) under ${DOCS_ROOT}/architecture/`);
      if (isolationWritten) console.error(`        isolation.json written`);
      console.error(`        next: glafka odysse --checks`);
      // Offered here because this is the moment the project's shape is known — the scan has just
      // read the codebase, so anyone reading this can tell which review lanes will apply. Offered,
      // never done: what a codebase is held to is the project's call, the same as guardrails.
      if (!standardsInstalled(repoRoot)) {
        console.error(
          `\n        no engineering standards installed. Review lanes (security, correctness,\n` +
            `        tests, performance, design) plus a short set of coding rules — yours to\n` +
            `        edit once written:\n` +
            `          glafka install <your-platform> --with-standards`,
        );
      }
    }

    if (proposals.length > 0) {
      console.error(`\n--- ${proposals.length} convention(s) observed, awaiting your decision ---`);
      console.error(formatPendingListing(proposals));
      console.error(decisionFooter('--keep', atTty));
    }

    if (workspace.length > 0) {
      console.error(
        `\n--- ${workspace.length} workspace setting(s) proposed, awaiting your decision ---`,
      );
      console.error(workspace.map((label, i) => `  ${i + 1}. ${label}`).join('\n'));
      console.error(decisionFooter('--workspace-keep', atTty));
    }

    if (!ranAgent) {
      console.error(
        `\nOnce the scan above is done and its observations are written, ` +
          `see what's pending: glafka odysse --list`,
      );
    }
  }

  // How the scanning agent files one observation. It reads the same category
  // flags as `glafka psyche`, so both write paths look the same to an agent.
  function recordProposal(): void {
    const flags = flagsOf(loadCategories(repoRoot));

    // The first flag we find wins, and the text runs until the next flag.
    // Same shape as psyche, on purpose.
    let target: string | undefined;
    let text: string | undefined;
    for (const [flag, flagTarget] of Object.entries(flags)) {
      const idx = args.indexOf(flag);
      if (idx === -1) continue;
      target = flagTarget;
      const words = [];
      for (const word of args.slice(idx + 1)) {
        if (word.startsWith('--')) break;
        words.push(word);
      }
      text = words.join(' ');
      break;
    }
    if (!target) {
      throw new Error(`usage: glafka odysse --propose ${Object.keys(flags).join('|')} "<rule>"`);
    }
    if (!text) throw new Error('glafka odysse --propose: no rule text after the category flag');

    const added = proposeEthos(repoRoot, { target, text });
    console.log(
      added ? `proposed  [${target}] ${text}` : `already known, skipped  [${target}] ${text}`,
    );
  }

  // One cheap LLM pass over the rules in force. It proposes; you decide. The proposals are saved, so
  // `--compact --keep 1,3` reads them back instead of paying for the pass a second time.
  function runCompact(): void {
    const keep = keepArg(args);

    // A --keep run answers the proposals already on disk. Running the pass
    // again would answer a different set from the one you just read.
    if (keep !== null) {
      const saved = readAuditProposals(repoRoot);
      if (saved.length === 0) {
        console.log('no compaction proposals pending — run `glafka odysse --compact` first');
        return;
      }
      const { applied, skippedAuthored } = applyAudit(
        repoRoot,
        saved,
        parseKeepArg(keep, saved.length),
      );
      for (const p of applied) console.log(`applied  ${p.action}  [${p.target}]  ${p.why}`);
      for (const p of skippedAuthored) {
        console.log(`SKIPPED  ${p.action}  [${p.target}] — touches ## Authored, which is yours`);
      }
      clearAuditProposals(repoRoot);
      console.log(`${applied.length}/${saved.length} proposal(s) applied`);
      // The count starts again from here, or it would be due on every push.
      writeAuditWatermark(repoRoot, rulesInForce(repoRoot).length);
      return;
    }

    // Proposals nobody has decided on yet. Running the pass again would pay
    // for a second call and replace the answer being read right now.
    const pending = readAuditProposals(repoRoot);
    if (pending.length > 0) return assertAuditDecidable(pending, null);

    const { ran, proposals, skip, prompt, ruleCount, detail } = runAuditPass({
      repoRoot,
      config,
      stateDir,
      observability: config.observability.enabled,
    });
    if (skip === 'no-rules') return console.log('no rules in force yet — nothing to compact');
    // No agent, so print the prompt for a person to paste. Unchanged behaviour.
    if (skip === 'no-agent') return console.log(prompt);
    if (skip === 'agent-failed') {
      return console.error(`odysse --compact: the agent failed (${detail})`);
    }
    if (ran && proposals.length === 0) {
      // A pass that found nothing still answered the question. Not recording
      // it means the same call is paid for again on the very next push.
      writeAuditWatermark(repoRoot, ruleCount);
      return console.log(`${ruleCount} rule(s) checked, nothing proposed`);
    }
    // Prints the listing and the three --keep forms, then stops. Nothing is
    // applied until a person answers.
    assertAuditDecidable(proposals, null);
  }

  // Kept for one release, so an existing script does not break in silence.
  if (args.includes('--audit')) {
    console.error('note: --audit is now --compact. The old spelling still works for now.');
  }
  if (args.includes('--compact') || args.includes('--audit')) return runCompact();
  if (args.includes('--list')) return printPendingListing();
  if (args.includes('--propose')) return recordProposal();
  if (args.includes('--checks')) return runChecksScan();

  const workspaceKeep = flagValue(args, '--workspace-keep');
  if (workspaceKeep !== null) return applyWorkspaceKeep(workspaceKeep);

  const keep = keepArg(args);
  if (keep !== null) return applyConventionKeep(keep);

  return runFullScan();
}
