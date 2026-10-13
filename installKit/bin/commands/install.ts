import path from 'node:path';
import { install, KNOWN_PLATFORMS } from '../../../src/commands/install/install.js';
import { superpowersReminder } from '../../../src/superpowers.js';
import { assertKnownFlags } from '../cli/args.js';
import { resolvePolicy, PROJECT_POLICY_PATH } from '../../guardrails/index.js';
import { checkAgentCmd, writeAgentCmd } from '../../../src/commands/install/checkAgentCmd.js';
import { verifierSetupSkip } from '../../../src/commands/install/verifierSetup.js';
import { seedStandards } from '../../../src/commands/install/seedStandards.js';
import type { SeedResult } from '../../../src/commands/install/seedStandards.js';
import { STANDARDS_DIR } from '../../../src/memory/standards.js';

// Every flag this command reads. Anything else is a typo, and a typo used to be
// silently ignored — sometimes into a different action entirely.
const INSTALL_FLAGS = ['--all', '--with-standards'];
const INSTALL_USAGE =
  `usage: glafka install <platform> …\n` +
  `       glafka install --all              every supported platform\n` +
  `       glafka install <platform> --with-standards\n` +
  `                                         also seed engineering standards\n\n` +
  `platforms: ${KNOWN_PLATFORMS.join(', ')}`;

// What `--with-standards` did, in words. Opt-in, so silence when the flag is absent is correct —
// a plain install and `--all` must not write a rule into anyone's project.
function standardsSection(result: SeedResult): string[] {
  const out = ['', 'engineering standards'];

  if (result.lanes.length > 0) {
    out.push(`  ${result.lanes.length} review lane(s) → ${STANDARDS_DIR}/  (reviewer only)`);
  }
  // Named individually: this is the one case where an install deliberately did NOT write something.
  for (const relative of result.blocked) {
    out.push(`  ⚠ left alone — ${relative} has uncommitted changes`);
  }
  if (result.blocked.length > 0) {
    out.push('    commit them first; then `git diff` shows exactly what this would replace');
  }

  const added = result.ethos.reduce((sum, entry) => sum + entry.added, 0);
  const skipped = result.ethos.reduce((sum, entry) => sum + entry.skipped, 0);
  out.push(
    added > 0
      ? `  ${added} rule(s) appended under "## Authored" in docs/glafka/ethos/  (coder + reviewer)`
      : '  no new ethos rules — every shipped rule is already in force here',
  );
  if (skipped > 0) out.push(`  ${skipped} already present, left as they are`);
  out.push('  All of it is yours now. Edit freely — the reviewer reads whatever you leave.');
  return out;
}

// Seeds them, or says how to. Never seeds without the flag: what a codebase is held to is the
// project's call, the same way guardrails are. The offer is still printed every time, because
// standards nobody mentioned are standards nobody adopts.
function standardsOutput({
  withStandards,
  repoRoot,
  packageRoot,
}: {
  withStandards: boolean;
  repoRoot: string;
  packageRoot: string;
}): string[] {
  if (withStandards) return standardsSection(seedStandards({ repoRoot, packageRoot }));
  return [
    '',
    'engineering standards — not installed',
    '  Review lanes (security, correctness, tests, performance, design) plus a short',
    '  set of coding rules. Opt in, and they become yours to edit:',
    '    glafka install <platform> --with-standards',
  ];
}

// Off by default is a deliberate don't-break-anyone's-project call. Off and
// unmentioned is how a project ends up enforcing nothing without deciding to.
function guardrailsSection(repoRoot: string): string[] {
  let configured: { level: number; levelName: string } | null;
  try {
    const { level, levelName, projectFile } = resolvePolicy({ repoRoot });
    configured = projectFile ? { level, levelName } : null;
  } catch {
    // The files are already copied by now, so a policy that will not parse
    // must not make a finished install read as a failed one.
    return ['guardrails', `  set in ${PROJECT_POLICY_PATH} — run: glafka guardrails`];
  }
  if (configured) {
    return [`guardrails — level ${configured.level} (${configured.levelName})`];
  }
  return [
    'guardrails — off',
    '  Nothing limits what an agent can read, write or run here.',
    '  Turn them on:  glafka guardrails --level 2   then   glafka guardrails --install-hook',
    '  See what each level stops:  glafka guardrails',
    // The timing, said HERE, because here is the only place it is free to act on. `create` and
    // `plan` warn too, but by then a ticket is under way and restarting the session costs the
    // brainstorm — so nobody does it, and the coder runs uncaged. Naming the cost at the one moment
    // there is no cost is the whole point of repeating it.
    '  ⚠ Do it NOW, before your first ticket: the hook only takes effect in a NEW agent',
    '    session, so turning it on mid-ticket means abandoning the one you are in.',
  ];
}

// Reviews only ever ran as a separate process when someone hand-wrote an agent command into
// .glafka.json, and nobody knew to — so the fresh-context review the docs promise never happened.
// Set it up here instead, for whichever agent was just installed. The command is RUN before it is
// written: a command that only looks right is the expensive failure, because a bare `claude -p`
// exits 0 having done nothing and glafka records that as a finished run.
function reviewerSection(repoRoot: string, platforms: string[]): string[] {
  for (const platform of platforms) {
    const { cmd, why } = checkAgentCmd(platform);
    if (!cmd) {
      // Try the next agent this project installed; only report once none of them worked.
      if (platform !== platforms[platforms.length - 1]) continue;
      return [
        '',
        'reviews run in this session',
        `  no reviewer agent could be set up — ${why}`,
        '  `glafka ergon <id> --review` prints the brief for this session to act on,',
        '  which is a real review. Set "agents": { "reviewer": ... } in .glafka.json',
        '  for one that runs as its own process, with no shared context.',
      ];
    }
    const { written, reason } = writeAgentCmd(repoRoot, 'reviewer', cmd);
    return [
      '',
      'reviews run as their own process',
      written
        ? `  ${platform} answered a test prompt, so it is now .glafka.json's "agents.reviewer"`
        : `  left as it is — ${reason}`,
    ];
  }
  return [];
}

// The role install used to leave unset on EVERY default install. `odysse`, `epistle`'s doc sync and
// architecture update, and the `genesis` drafts all resolve it, and with nothing there they printed
// their prompt and exited 0 with nothing recorded as skipped — so a project's architecture map went
// quietly stale and the push that was supposed to update it reported success. Writing only the
// reviewer was never a decision, it was the feature stopping one role short of finished.
//
// Probed separately from the reviewer, not copied from it: the reviewer command is deliberately
// read-only, and a reporter that cannot write is refused every edit and exits 0 — which glafka
// records as a finished run.
function reporterSection(repoRoot: string, platforms: string[]): string[] {
  for (const platform of platforms) {
    const { cmd, why } = checkAgentCmd(platform, { role: 'reporter' });
    if (!cmd) {
      if (platform !== platforms[platforms.length - 1]) continue;
      return [
        '',
        'doc and architecture updates run in this session',
        `  no reporter agent could be set up — ${why}`,
        "  `odysse` and `epistle`'s doc steps will PRINT their prompt for this session",
        '  to act on. Set "agents": { "reporter": ... } in .glafka.json for one that',
        '  runs as its own process.',
      ];
    }
    const { written, reason } = writeAgentCmd(repoRoot, 'reporter', cmd);
    return [
      '',
      'doc and architecture updates run as their own process',
      written
        ? `  ${platform} answered a test prompt, so it is now .glafka.json's "agents.reporter"`
        : `  left as it is — ${reason}`,
    ];
  }
  return [];
}

// The QA tester, set up like the reporter, with its own command: it must run shell
// commands (curl, the project's CLI), and it should not edit the code it tests.
function verifierSection(repoRoot: string, platforms: string[]): string[] {
  const skip = verifierSetupSkip(repoRoot);
  if (skip) return ['', 'QA testing runs as its own process', `  ${skip}`];
  for (const platform of platforms) {
    const { cmd, why } = checkAgentCmd(platform, { role: 'verifier' });
    if (!cmd) {
      if (platform !== platforms[platforms.length - 1]) continue;
      return [
        '',
        'QA testing needs a person',
        `  no verifier agent could be set up — ${why}`,
        '  with acceptance criteria, `glafka ergon <id> --review` then needs a person at a',
        '  terminal. Set "agents": { "verifier": ... } in .glafka.json for one that runs as',
        '  its own process. It must be allowed to run shell commands.',
      ];
    }
    const { written, reason } = writeAgentCmd(repoRoot, 'verifier', cmd);
    return [
      '',
      'QA testing runs as its own process',
      written
        ? `  ${platform} answered a test prompt, so it is now .glafka.json's "agents.verifier"`
        : `  left as it is — ${reason}`,
    ];
  }
  return [];
}

// How each agent spells a glafka command in its own session.
function slashCommand(platform: string): (name: string) => string {
  if (platform === 'cursor' || platform === 'opencode') return (name) => `/glafka-${name}`;
  if (platform === 'kimi') return (name) => `/skill:glafka-${name}`;
  if (platform === 'github') return (name) => `skill glafka-${name}`;
  return (name) => `/glafka:${name}`;
}

// Each agent names its commands its own way, so show the form for the first one installed.
function startHereSection(platform: string): string[] {
  const call = slashCommand(platform);
  const rows: Array<[string, string]> = [
    ['glafka prosopon', 'how answers get written'],
    [call('odysse'), 'map the codebase, once (optional but recommended)'],
    [call('genesis'), 'open a ticket from an idea'],
  ];
  const width = Math.max(...rows.map(([command]) => command.length));
  return [
    '',
    'start here',
    ...rows.map(([command, what]) => `  ${command.padEnd(width)}    ${what}`),
  ];
}

export function runInstall({
  args,
  repoRoot,
  packageRoot,
}: {
  args: string[];
  repoRoot: string;
  packageRoot: string;
}): void {
  assertKnownFlags(args, INSTALL_FLAGS, INSTALL_USAGE);
  // No default platform on purpose. Which agent a project uses is the one thing
  // glafka must not guess, so a bare `glafka install` asks instead of picking.
  const all = args.includes('--all');
  const withStandards = args.includes('--with-standards');
  // Flags are not platform names. Passing one through would fail the unknown-platform check.
  const named = args.filter((arg) => !arg.startsWith('--'));
  if (!all && named.length === 0) throw new Error(INSTALL_USAGE);
  const platforms = all ? ['all'] : named;
  const {
    installed,
    platforms: stamped,
    version,
    skipped,
    missingDependencies,
  } = install({
    packageRoot,
    targetRoot: repoRoot,
    platforms,
  });
  // One shape for the whole report: a heading at the left margin, its detail
  // indented two, a blank line between. Built as one block so it stays that way.
  const out: string[] = [installed.length ? `glafka v${version} installed` : 'nothing to install'];
  if (installed.length > 0) out.push('', ...installed.map((item) => `  ${item}`));

  // A vendored copy missing its imports runs no command at all, so this is
  // never a warning to bury under the rest of the output.
  if (missingDependencies.length > 0) {
    out.push(
      '',
      '⚠ could not vendor',
      `  ${missingDependencies.join(', ')} — .glafka/ will not run`,
      '  re-install glafka itself (npm install -g .), then run this again',
    );
  }

  out.push('', ...guardrailsSection(repoRoot));
  out.push(...reviewerSection(repoRoot, stamped));
  out.push(...reporterSection(repoRoot, stamped));
  out.push(...verifierSection(repoRoot, stamped));

  out.push(...standardsOutput({ withStandards, repoRoot, packageRoot }));

  out.push(...startHereSection(stamped[0] ?? 'claude'));

  // We left alone any file we do not own. Say which ones, because
  // a silent skip is nearly as bad as a silent overwrite.
  if (skipped.length > 0) {
    out.push(
      '',
      "left alone (already yours, not glafka's)",
      ...skipped.map((file) => `  ${path.relative(repoRoot, file)}`),
    );
  }

  const hint = superpowersReminder(stamped);
  if (hint) out.push('', hint);

  console.log(out.join('\n'));
}
