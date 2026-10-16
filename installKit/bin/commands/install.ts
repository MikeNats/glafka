import path from 'node:path';
import { nodeProblem } from '../../../src/util/nodeVersion.js';
import { install, KNOWN_PLATFORMS } from '../../../src/commands/install/install.js';
import { superpowersReminder } from '../../../src/superpowers.js';
import { assertKnownFlags } from '../cli/args.js';
import { resolvePolicy, PROJECT_POLICY_PATH } from '../../guardrails/index.js';
import { checkAgentCmd, writeAgentCmd } from '../../../src/commands/install/checkAgentCmd.js';
import type { ProbeResult } from '../../../src/commands/install/checkAgentCmd.js';
import { roleSetupSkip } from '../../../src/commands/install/verifierSetup.js';
import { seedStandards } from '../../../src/commands/install/seedStandards.js';
import type { SeedResult } from '../../../src/commands/install/seedStandards.js';
import { STANDARDS_DIR } from '../../../src/memory/standards.js';
import { installCodeGraph } from '../../../src/commands/install/codeGraph.js';

// Every flag this command reads. Anything else is a typo, and a typo used to be
// silently ignored — sometimes into a different action entirely.
const INSTALL_FLAGS = ['--all', '--with-standards', '--no-code-graph'];
const INSTALL_USAGE =
  `usage: glafka install <platform> …\n` +
  `       glafka install --all              every supported platform\n` +
  `       glafka install <platform> --with-standards\n` +
  `                                         also seed engineering standards\n` +
  `       glafka install <platform> --no-code-graph\n` +
  `                                         skip the code map tool (codebase-memory-mcp)\n\n` +
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

// What install says about one agent role: when it was written, and when no agent could be.
interface RoleText {
  done: string;
  failed: string;
  manual: string[];
}

// Each role is probed before it is written: a command that only LOOKS right is the expensive
// failure, because a bare `claude -p` exits 0 having done nothing and glafka records a finished run.
// - reviewer: read-only on purpose, so reviews run with fresh context.
// - reporter: WRITES (odysse, epistle's doc sync, genesis drafts). Never the reviewer's command:
//   refused every edit, it exits 0. Without one, those steps printed their prompt and did nothing.
// - verifier: the QA tester. Runs shell commands, should not edit the code it tests.
// - coder: runs tickets on their own (`ergon --background`, Elaia).
const ROLE_TEXT: Record<string, RoleText> = {
  reviewer: {
    done: 'reviews run as their own process',
    failed: 'reviews run in this session',
    manual: [
      '  `glafka ergon <id> --review` prints the brief for this session to act on,',
      '  which is a real review. Set "agents": { "reviewer": ... } in .glafka.json',
      '  for one that runs as its own process, with no shared context.',
    ],
  },
  reporter: {
    done: 'doc and architecture updates run as their own process',
    failed: 'doc and architecture updates run in this session',
    manual: [
      "  `odysse` and `epistle`'s doc steps will PRINT their prompt for this session",
      '  to act on. Set "agents": { "reporter": ... } in .glafka.json for one that',
      '  runs as its own process.',
    ],
  },
  verifier: {
    done: 'QA testing runs as its own process',
    failed: 'QA testing needs a person',
    manual: [
      '  with acceptance criteria, `glafka ergon <id> --review` then needs a person at a',
      '  terminal. Set "agents": { "verifier": ... } in .glafka.json for one that runs as',
      '  its own process. It must be allowed to run shell commands.',
    ],
  },
  coder: {
    done: 'tickets can run on their own',
    failed: 'tickets are coded in this session',
    manual: [
      '  `glafka ergon <id>` prints the brief for this session to act on. Set',
      '  "agents": { "coder": ... } in .glafka.json for a coder that runs on its own.',
    ],
  },
};

// Probes the first platform that works, writes `agents.<role>`, and says what happened.
function roleSection(
  repoRoot: string,
  platforms: string[],
  role: string,
  seen: Map<string, ProbeResult>,
): string[] {
  const text = ROLE_TEXT[role]!;
  // Roles that fall back to agents.default: writing one would override it.
  const skip = role === 'verifier' || role === 'coder' ? roleSetupSkip(repoRoot, role) : null;
  if (skip) return ['', text.done, `  ${skip}`];
  for (const platform of platforms) {
    const { cmd, why } = checkAgentCmd(platform, { role, seen });
    if (!cmd) {
      // Try the next agent this project installed; only report once none of them worked.
      if (platform !== platforms[platforms.length - 1]) continue;
      return ['', text.failed, `  no ${role} agent could be set up — ${why}`, ...text.manual];
    }
    const { written, reason } = writeAgentCmd(repoRoot, role, cmd);
    return [
      '',
      text.done,
      written
        ? `  ${platform} answered a test prompt, so it is now .glafka.json's "agents.${role}"`
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
  // On by default: a code map with no AI. Skipped only when someone asks.
  const withCodeGraph = !args.includes('--no-code-graph');
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

  // Said before anything else runs: checks and coders stop on an old Node, so fix it first.
  const tooOld = nodeProblem(repoRoot);
  if (tooOld)
    out.push('', '⚠ Node is too old for this project', `  ${tooOld.replace('\n', '\n  ')}`);
  out.push('', ...guardrailsSection(repoRoot));
  // Roles with the same command share one probe: claude needs two, every other agent one.
  const seen = new Map<string, ProbeResult>();
  for (const role of ['reviewer', 'reporter', 'verifier', 'coder']) {
    out.push(...roleSection(repoRoot, stamped, role, seen));
  }

  out.push(...standardsOutput({ withStandards, repoRoot, packageRoot }));
  if (withCodeGraph) out.push(...installCodeGraph());

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
