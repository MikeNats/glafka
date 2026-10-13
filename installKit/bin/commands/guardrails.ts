import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import {
  resolvePolicy,
  loadLevel,
  PROJECT_POLICY_PATH,
  scopesFor,
  explain,
  explainLayer,
  LAYER_NAMES,
  detect,
  selfTest,
  audit,
  repin,
  claimRecordedRecently,
} from '../../guardrails/index.js';
import { resolveAgentCmd } from '../../../src/config.js';
import { ROLES } from '../../../src/types/ticket.js';
import { commitPaths, currentBranch } from '../../../src/util/git.js';
import {
  listTickets,
  readTicket,
  writeTicket,
  withTicketLock,
} from '../../../src/ticket/ticketStore.js';
import { flagValue, positionalId } from '../cli/args.js';
import { installAllHooks } from '../hooks/install.js';
import type { InstallerOutcome } from '../hooks/install.js';
import type { Config } from '../../../src/types/config.js';
import { assertKnownFlags } from '../cli/args.js';

// Every flag this command reads. `--run-hook` is handled in glafka.ts before dispatch and never
// arrives here, but it is listed so it never reads as a typo. Anything else IS one, and `--lvel 2`
// silently printing the overview instead of changing the level is exactly the bug this stops.
const GUARDRAILS_FLAGS = [
  '--level',
  '--explain',
  '--claim',
  '--repin',
  '--install-hook',
  '--backends',
  '--test',
  '--log',
  '--run-hook',
];
const GUARDRAILS_USAGE = [
  'usage: glafka guardrails                     what is enforced right now',
  '       glafka guardrails --level <0-4>       save the level, then show it',
  '       glafka guardrails --explain <layer>   what one layer stops',
  '       glafka guardrails --install-hook      wire the hook into this agent',
  '       glafka guardrails --backends|--test|--log',
].join('\n');

export function runGuardrails({
  args,
  repoRoot,
  stateDir,
  config,
  packageRoot,
}: {
  args: string[];
  repoRoot: string;
  stateDir: string;
  config: Pick<Config, 'baseRef' | 'agents'>;
  packageRoot: string;
}): void {
  assertKnownFlags(args, GUARDRAILS_FLAGS, GUARDRAILS_USAGE);
  // A level number or a layer name can look like a ticket id.
  const guardrailsTicketId = () => positionalId(args, { single: ['--level', '--explain'] });

  // Accept a rules change for one ticket, by hand. Locked, like every other ticket write.
  function repinTicket(id: string | undefined): void {
    if (!id) throw new Error('--repin needs a ticket id');
    const { was, next } = withTicketLock(stateDir, id, () => {
      const ticket = readTicket(stateDir, id);
      const result = repin({ repoRoot, ticket, now: new Date().toISOString() });
      writeTicket(stateDir, { ...ticket, guardrails: result.next, updated: result.next.pinnedAt });
      return result;
    });
    console.log(`${id}  repinned`);
    console.log(`  was: ${was ? `level ${was.level} ${was.hash}` : '(no pin)'}`);
    console.log(`  now: level ${next.level} ${next.hash}`);
  }

  // Turns on the guard hooks for every tool we support.
  function installHooks() {
    // A worktree only holds committed files, so this must be committed
    // on the base branch.
    const onBranch = currentBranch(repoRoot);
    if (onBranch !== config.baseRef) {
      throw new Error(
        `--install-hook must run on ${config.baseRef} (tickets are cut from it), not ${onBranch}. ` +
          `git checkout ${config.baseRef} && glafka guardrails --install-hook`,
      );
    }

    const results = installAllHooks(repoRoot, packageRoot);
    for (const { name, scope, filePath, already, error, caveat } of results) {
      if (error) {
        console.log(`${name}: FAILED — ${error}`);
      } else {
        console.log(`${name}: ${already ? 'already installed' : 'installed'} — ${filePath}`);
      }
      if (scope.startsWith('global') && !error) console.log(`  ⚠ ${scope}`);
      // Printed even when the install failed: what the harness cannot
      // enforce does not depend on whether the file got written.
      if (caveat) console.log(`  ⚠ ${caveat}`);
    }

    const toCommit = results.filter(
      (result): result is InstallerOutcome & { filePath: string } =>
        result.scope === 'project' && !result.error && !result.already && result.filePath !== null,
    );
    if (toCommit.length > 0) {
      try {
        const commit = commitPaths(
          repoRoot,
          toCommit.map((result) => result.filePath),
          `glafka: install guardrails hooks (${toCommit.map((result) => result.name).join(', ')})`,
        );
        console.log(
          commit
            ? `committed ${commit.sha.slice(0, 7)} — so ticket worktrees see it too`
            : 'nothing to commit',
        );
      } catch (err) {
        console.log(`FAILED to commit the hook config — do it yourself: ${(err as Error).message}`);
      }
    }
    console.log('restart your agent session for it to take effect');
  }

  // Shows what this machine can really enforce.
  function printBackends() {
    for (const backend of detect()) {
      console.log(
        `${backend.available ? 'yes' : 'no '}  ${backend.name.padEnd(10)} ${backend.why}`,
      );
      console.log(`      ${backend.strength}`);
    }
  }

  // Runs real checks inside the sandbox.
  function testSandbox() {
    // Use the newest ticket when none is named.
    const id = guardrailsTicketId() ?? listTickets(stateDir).at(-1)?.id;
    if (!id) {
      throw new Error('--test needs a ticket (its worktree is what gets probed)');
    }
    // Fail loudly if the id is wrong.
    readTicket(stateDir, id);

    const levelIdx = args.indexOf('--level');
    const levelOverride = levelIdx === -1 ? null : Number(args[levelIdx + 1]);
    const { policy } = resolvePolicy({ repoRoot, levelOverride });
    console.log(`${id}:`);
    if (!policy.sandbox.enabled) {
      console.log(
        `  level ${policy.level} has no sandbox — nothing to test. try \`--test --level 4\`.`,
      );
      return;
    }
    const scopes = scopesFor({ repoRoot, ticketId: id });
    const results = selfTest(policy, {
      worktree: scopes.TICKET_WORKTREE,
      scratch: scopes.TICKET_SCRATCH,
      stateDir,
      // Checks whether the coder's command can run inside the sandbox.
      agentCmd: resolveAgentCmd({ config, role: ROLES.CODER }),
    });
    // Null means the check could not run. Never show that as a pass.
    for (const result of results) {
      const mark = result.pass === null ? '????' : result.pass ? 'PASS' : 'FAIL';
      console.log(`  ${mark}  ${result.label.padEnd(26)} ${result.detail}`);
    }
    // A real FAIL is what makes this command fail. `????` is a check that could not be run, or a fact
    // about this backend rather than a verdict — it is printed, and it must not turn a working cage into a red exit.
    if (results.some((result) => result.pass === false)) process.exitCode = 1;
  }

  // Shows what the agent tried to do.
  function printAuditLog() {
    const id = guardrailsTicketId();
    if (!id) {
      throw new Error('--log needs a ticket id (its audit log is what gets read)');
    }
    // Fail loudly if the id is wrong.
    readTicket(stateDir, id);

    const { policy } = resolvePolicy({ repoRoot });
    const entries = audit.read(policy, { stateDir, ticketId: id });
    const summary = audit.summarise(entries);
    console.log(`${id}: ${summary.total} decision(s) logged, ${summary.deniedCount} denied`);
    console.log('\ncommands used:');
    for (const [name, count] of summary.commands)
      console.log(`  ${String(count).padStart(5)}  ${name}`);
    if (summary.outsidePaths.length > 0) {
      console.log('\npaths refused outside the worktree:');
      for (const outsidePath of summary.outsidePaths.slice(0, 20)) console.log(`  ${outsidePath}`);
    }
    if (summary.denied.length > 0) {
      console.log('\nlast refusals:');
      for (const denial of summary.denied)
        console.log(`  [${denial.layer ?? 'policy'}] ${denial.reason}`);
    }
  }

  // Explains one layer in detail.
  function printLayerExplanation() {
    const explainIdx = args.indexOf('--explain');
    const name = args[explainIdx + 1];
    // Missing name and unknown name are both usage errors. Without this, a bare `--explain` printed the
    // literal string "undefined" into the message and exited 0, so nothing wrapping this command could see it fail.
    if (name === undefined || name.startsWith('--')) {
      throw new Error(`usage: glafka guardrails --explain <layer>  (${LAYER_NAMES.join(', ')})`);
    }
    if (!LAYER_NAMES.includes(name)) {
      throw new Error(`unknown layer "${name}" — known: ${LAYER_NAMES.join(', ')}`);
    }
    const id = guardrailsTicketId();
    console.log(explainLayer(name, { repoRoot, ticketId: id ?? null }));
  }

  // Saves the level to the project file, so `--level 2` really turns guardrails on.
  // Committed on the base branch, like --install-hook: a worktree only sees committed files.
  function saveLevel(): void {
    const level = Number(flagValue(args, '--level', 'a level from 0 to 4'));
    loadLevel(level); // an unknown level throws here, naming the real ones
    const onBranch = currentBranch(repoRoot);
    if (onBranch !== config.baseRef) {
      throw new Error(
        `--level must run on ${config.baseRef} (tickets are cut from it), not ${onBranch}. ` +
          `git checkout ${config.baseRef} && glafka guardrails --level ${level}`,
      );
    }
    // A broken file stops here, before we write over it.
    resolvePolicy({ repoRoot });
    const filePath = path.join(repoRoot, PROJECT_POLICY_PATH);
    // Read as plain JSON, not through the schema, so keys the schema drops are kept.
    const current = fs.existsSync(filePath)
      ? z.record(z.string(), z.unknown()).parse(JSON.parse(fs.readFileSync(filePath, 'utf8')))
      : {};
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const next = Object.assign({ level }, current, { level });
    fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`);
    const commit = commitPaths(repoRoot, [filePath], `glafka: guardrails level ${level}`);
    console.log(
      `level ${level} saved to ${PROJECT_POLICY_PATH}` +
        (commit ? ` — committed ${commit.sha.slice(0, 7)}` : ''),
    );
    console.log('open tickets keep their old rules until `glafka guardrails --repin <id>`\n');
  }

  // The default: show the whole picture.
  function printOverview() {
    const levelIdx = args.indexOf('--level');
    const levelOverride = levelIdx === -1 ? null : Number(args[levelIdx + 1]);
    const id = guardrailsTicketId();
    const { text } = explain({ repoRoot, ticketId: id ?? null, levelOverride });
    console.log(text);
  }

  // `--claim <id>` is not really run for its own sake. What matters is that running it goes through
  // the hook, which is the only place that sees both this session's id and the ticket id, and
  // records the pair. So the command itself only has to report what the hook did or
  // did not do.
  function claimSession(id: string | undefined): void {
    if (!id) throw new Error('--claim needs a ticket id');
    readTicket(stateDir, id);

    // Level 0 enforces nothing by design, so no marker can exist and failing here blocked every fresh
    // install. Level 1+ still fails hard: a cage was asked for and is missing.
    const { level } = resolvePolicy({ repoRoot });
    if (level === 0) {
      console.log(`${id}  nothing to claim — guardrails are off (level 0) for this project`);
      console.log(
        `  No layer runs on anyone's tool calls, so there is nothing to attribute. Carry on.`,
      );
      console.log(
        `  To turn them on: \`glafka guardrails --level 2\` then ` +
          `\`glafka guardrails --install-hook\` on ${config.baseRef} (needs a fresh agent session).`,
      );
      return;
    }

    // This command cannot read its own session id — that value exists only inside the hook payload. So it
    // checks for the marker the hook should have written on the way here, which is the same evidence seen from the other side.
    if (claimRecordedRecently({ stateDir, ticketId: id })) {
      console.log(`${id}  claimed — this session's tool calls are now checked against it`);
      return;
    }
    console.log(`${id}  NOT claimed — no session marker was recorded`);
    console.log(
      `  The guardrails hook did not see this command. Either it is not installed here ` +
        `(run \`glafka guardrails --install-hook\` on ${config.baseRef}), or this ran outside ` +
        `an agent session, or this harness sends no session id.`,
    );
    console.log(
      `  Until a session claims this ticket, its tool calls are UNATTRIBUTED: no layer runs ` +
        `on them. They are recorded as such — check \`glafka guardrails --log ${id}\`.`,
    );
    process.exitCode = 1;
  }

  const claimIdx = args.indexOf('--claim');
  if (claimIdx !== -1) return claimSession(args[claimIdx + 1]);
  const repinIdx = args.indexOf('--repin');
  if (repinIdx !== -1) return repinTicket(args[repinIdx + 1]);
  if (args.includes('--install-hook')) return installHooks();
  if (args.includes('--backends')) return printBackends();
  if (args.includes('--test')) return testSandbox();
  if (args.includes('--log')) return printAuditLog();
  if (args.includes('--explain')) return printLayerExplanation();
  if (args.includes('--level')) saveLevel();
  return printOverview();
}
