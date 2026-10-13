#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CommandContext } from './types/cli.js';
import { findRepoRoot } from '../../src/util/git.js';
import { loadConfig, resolveBaseRef, resolveChecksCmd, resolveE2eCmd } from '../../src/config.js';
import { readIsolationProfile, projectPersonasDir } from '../../src/memory/docsStore.js';
import { loadActivePersonaContent } from '../../src/memory/persona.js';
import { runHookAdapter } from './hooks/runAdapter.js';

import { printVersion } from './commands/version.js';
import { runGenesis } from './commands/genesis.js';
import { runCreate } from './commands/create.js';
import { runSpec } from './commands/spec.js';
import { runPlan } from './commands/plan.js';
import { runCancel } from './commands/cancel.js';
import { runErgon } from './commands/ergon.js';
import { runChecksCommand } from './commands/checks.js';
import { runPoreia } from './commands/poreia.js';
import { runLogos } from './commands/logos.js';
import { runVima } from './commands/vima.js';
import { runLysis } from './commands/lysis.js';
import { runEpistle } from './commands/epistle.js';
import { runOdysse } from './commands/odysse.js';
import { runHeureka } from './commands/heureka.js';
import { runPsyche } from './commands/psyche.js';
import { runApofasi } from './commands/apofasi.js';
import { runKrisis } from './commands/krisis.js';
import { runEpalitheusis } from './commands/epalitheusis.js';
import { runAporia } from './commands/aporia.js';
import { runHygeia } from './commands/hygeia.js';
import { runProsopon } from './commands/prosopon.js';
import { runGuardrails } from './commands/guardrails.js';
import { runInstall } from './commands/install.js';
import { runAuditCommand } from './commands/audit.js';

// This file runs from two places, at two different depths.
// So we walk up until we find package.json, instead of guessing.
function findPackageRoot(startDir: string): string {
  let dir = startDir;
  while (!fs.existsSync(path.join(dir, 'package.json'))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`no package.json found above ${startDir}`);
    dir = parent;
  }
  return dir;
}

const PACKAGE_ROOT = findPackageRoot(path.dirname(fileURLToPath(import.meta.url)));
// Two layouts, same reason as findPackageRoot. In the package everything shipped
// sits under installKit/; install flattens it into .glafka/.
function shippedDir(name: string): string {
  const inKit = path.join(PACKAGE_ROOT, 'installKit', name);
  return fs.existsSync(inKit) ? inKit : path.join(PACKAGE_ROOT, name);
}

// The ones glafka ships. A project's own are added in front of these below,
// so a project can override a shipped persona by name.
const SHIPPED_PERSONAS_DIR = shippedDir('personas');

// One line per command, in the order you meet them. A bare list of twenty
// Greek verbs told nobody anything.
const COMMANDS: ReadonlyArray<[string, string]> = [
  ['install', 'add glafka to this project (run this first)'],
  ['odysse', 'build or refresh the architecture map, and find how the project verifies itself'],
  ['genesis', 'open a ticket from an idea: spec, plan, then code'],
  ['heureka', 'explore a rough idea in a worktree, with no fixed plan'],
  ['create', 'make a bare ticket, no worktree yet'],
  ['spec', 'attach a spec to a ticket'],
  ['plan', 'attach a plan — this is what creates the branch and worktree'],
  ['ergon', 'implement the plan; --review runs a fresh reviewer over the diff'],
  ['checks', "run this ticket's checks and record the result — no LLM, no review round"],
  ['krisis', "record the reviewer's verdict"],
  ['epalitheusis', 'record a QA result for one acceptance criterion (a person may --skip one)'],
  ['aporia', 'flag that the coder is stuck and needs a person'],
  ['epistle', 'push the branch and open a PR'],
  [
    'lysis',
    'close a ticket: tear down its worktree (the branch is kept; --sweep removes dead ones)',
  ],
  ['cancel', 'abandon a ticket before it is pushed'],
  ['poreia', 'ticket status, no LLM calls (--all lists every open ticket)'],
  ['logos', 'the same status, re-worded by an agent (costs tokens)'],
  ['vima', 'move a ticket forward by one step (--all for every ticket, --restart just its app)'],
  ['psyche', 'record a project convention on a ticket'],
  ['apofasi', 'record a decision taken on a ticket'],
  ['prosopon', 'turn a persona on or off'],
  ['hygeia', 'npm-only: semver-safe dependency updates plus an audit fix'],
  ['guardrails', 'show or configure what the coder agent may touch'],
  ['audit', 'what each agent run cost — time, tokens, outcome'],
  ['version', 'print the version'],
];

function helpText(): string {
  const width = Math.max(...COMMANDS.map(([name]) => name.length));
  return [
    'glafka — an agent orchestrator for software development.',
    '',
    'usage: glafka <command> [args]',
    '',
    ...COMMANDS.map(([name, what]) => `  ${name.padEnd(width)}  ${what}`),
    '',
    'Most commands take a ticket id. `glafka poreia --all` lists the ones you have.',
    'Full docs: README.md, and docs/glafka/skills/ in a project you installed into.',
  ].join('\n');
}

// Async, because picking ports and running checks both need to wait.
async function run(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  // Checking the version should not need a git repo.
  if (command === '--version' || command === '-v' || command === 'version') {
    return printVersion({ packageRoot: PACKAGE_ROOT });
  }

  // Help is not an error, and it must not need a git repo either — asking what a tool does is the one
  // thing you do before you are set up. Asked for, it goes to stdout and exits 0; reached by typing nothing or a wrong verb, it goes to stderr and exits 1.
  if (command === '--help' || command === '-h' || command === 'help') {
    console.log(helpText());
    return;
  }
  if (command === undefined) {
    console.error(helpText());
    process.exitCode = 1;
    return;
  }

  // Every hook runs this, on every tool call. We skip finding the repo,
  // because the hook already gets what it needs, and git is slow.
  if (command === 'guardrails' && args[0] === '--run-hook') {
    return runHookAdapter({ args, packageRoot: PACKAGE_ROOT });
  }

  // Paths every command below uses, computed once.
  const repoRoot = findRepoRoot();
  const stateDir = path.join(repoRoot, '.glafka');

  // install runs before config is loaded, because a fresh project has no config yet.
  if (command === 'install') {
    runInstall({ args, repoRoot, packageRoot: PACKAGE_ROOT });
    return;
  }

  // Reads the project's config file if there is one.
  // A missing file or field falls back to a default.
  const config = loadConfig(repoRoot);

  // Your own setting wins first, then what the scan found and
  // a person approved, then the default.
  const profile = readIsolationProfile(repoRoot);
  config.baseRef = resolveBaseRef({ repoRoot, config, profile });
  config.checksCmd = resolveChecksCmd({ config, profile });
  config.e2eCmd = resolveE2eCmd({ config, profile });

  // How you want to be written to. It shapes the wording
  // of reports and findings only, never the code.
  const personasDir = [projectPersonasDir(repoRoot), SHIPPED_PERSONAS_DIR];
  const personaContent = loadActivePersonaContent(stateDir, personasDir);

  // Everything a command might need. Each one takes only what it uses.
  const context: CommandContext = {
    args,
    repoRoot,
    stateDir,
    config,
    personaContent,
    profile,
    packageRoot: PACKAGE_ROOT,
    personasDir,
  };

  switch (command) {
    case 'genesis':
      return runGenesis(context);
    case 'create':
      return runCreate(context);
    case 'spec':
      return runSpec(context);
    case 'plan':
      return runPlan(context);
    case 'cancel':
      return runCancel(context);
    case 'ergon':
      return runErgon(context);
    case 'checks':
      return runChecksCommand(context);
    case 'poreia':
      return runPoreia(context);
    case 'logos':
      return runLogos(context);
    case 'vima':
      return runVima(context);
    case 'lysis':
      return runLysis(context);
    case 'epistle':
      return runEpistle(context);
    case 'odysse':
      return runOdysse(context);
    case 'heureka':
      return runHeureka(context);
    case 'psyche':
      return runPsyche(context);
    case 'apofasi':
      return runApofasi(context);
    case 'krisis':
      return runKrisis(context);
    case 'epalitheusis':
      return runEpalitheusis(context);
    case 'aporia':
      return runAporia(context);
    case 'hygeia':
      return runHygeia(context);
    case 'prosopon':
      return runProsopon(context);
    case 'guardrails':
      return runGuardrails(context);
    case 'audit':
      return runAuditCommand(context);
    default:
      console.error(`unknown command "${command}"\n\n${helpText()}`);
      process.exitCode = 1;
  }
}

// Catches errors, so you see a clean message and not a long stack trace.
run().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
