import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import { TICKET_ENV_FILE } from '../../ticket/resources/ticketEnv.js';

// Each tool picks its own folder name. That is not our choice.
const PLATFORM_DIRS = {
  claude: '.claude',
  cursor: '.cursor',
  opencode: '.opencode',
  gemini: '.gemini',
  kimi: '.kimi',
  github: '.github',
};
// The instructions file each supported platform reads. Same keys as
// PLATFORM_DIRS, so adding a platform cannot forget one.
const PLATFORM_INSTRUCTION_FILES: Record<keyof typeof PLATFORM_DIRS, string> = {
  claude: 'CLAUDE.md',
  cursor: 'AGENTS.md',
  opencode: 'AGENTS.md',
  gemini: 'GEMINI.md',
  kimi: 'AGENTS.md',
  github: '.github/copilot-instructions.md',
};

// Deduplicated: three platforms share AGENTS.md.
export const AGENT_INSTRUCTION_FILES = [...new Set(Object.values(PLATFORM_INSTRUCTION_FILES))];

type Platform = keyof typeof PLATFORM_DIRS;
export const KNOWN_PLATFORMS = Object.keys(PLATFORM_DIRS) as Platform[];

// Kimi needs one extra folder, because its agent file lives outside .kimi/.
// Every other tool keeps its agent file in the folder we already copy.
const EXTRA_PLATFORM_DIRS: Partial<Record<Platform, string[]>> = {
  kimi: ['.kimi-code'],
};

// The agent-config paths install writes into. Guardrails must deny writes to all of them, or an
// agent can edit the rules it runs under. `.github` is listed as `.github/skills` only — the rest
// of `.github` is the project's CI. test/guardrails/filesystem.test.ts asserts the level files
// cover this list.
export const AGENT_CONFIG_PATHS = [
  '.claude',
  '.cursor',
  '.opencode',
  '.gemini',
  '.kimi',
  '.kimi-code',
  '.github/skills',
  '.github/hooks',
];

// Everything glafka hands to a project lives under this one folder in the package.
// Source only — where each piece LANDS in the target is unchanged.
export const KIT = 'installKit';

// Never copied into a project. A pipeline of ours that leaked in
// would wipe out the project's own.
const NEVER_INSTALLED = ['.github/workflows'];

// Junk files that do not belong in someone else's repo.
const JUNK_FILES = new Set(['.DS_Store', 'Thumbs.db', '.localized']);

// The paths glafka OWNS, so an upgrade may overwrite them. Every file we
// ship has "glafka" in its name. Anything else belongs to the project.
function glafkaOwns(relative: string): boolean {
  return relative
    .split(path.sep)
    .some((part) => part === 'glafka' || part === '.glafka' || part.startsWith('glafka-'));
}

interface CopyContext {
  targetRoot: string;
  skipped: string[];
  // vendorCli writes into .glafka/, which is our folder from top to bottom.
  alwaysOwned?: boolean;
}

function copyRecursive(src: string, dest: string, ctx: CopyContext): void {
  const relative = path.relative(ctx.targetRoot, dest);
  const posix = relative.split(path.sep).join('/');
  if (NEVER_INSTALLED.some((skip) => posix === skip || posix.startsWith(`${skip}/`))) return;

  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry), ctx);
    }
    return;
  }

  if (JUNK_FILES.has(path.basename(src))) return;
  if (fs.existsSync(dest) && !ctx.alwaysOwned && !glafkaOwns(relative)) {
    ctx.skipped.push(dest);
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

// The runtime dependencies the vendored copy imports by bare name. Without these inside .glafka/,
// every command dies with ERR_MODULE_NOT_FOUND in any project that does not happen to depend on them itself.
const VENDORED_DEPENDENCIES = ['zod'];

// Where a dependency really lives. A resolve handles hoisting (pnpm, workspaces)
// that a plain node_modules/<name> guess would miss.
function findDependency(packageRoot: string, name: string): string | null {
  const require = createRequire(path.join(packageRoot, 'package.json'));
  try {
    return path.dirname(require.resolve(`${name}/package.json`));
  } catch {
    const guess = path.join(packageRoot, 'node_modules', name);
    return fs.existsSync(guess) ? guess : null;
  }
}

// Copies the dependencies into .glafka/node_modules/, so the vendored CLI runs on its own. Returns
// the names it could not find, for the caller to report: a silent miss here looks like a working install and is not one.
function vendorDependencies(packageRoot: string, dest: string, skipped: string[]): string[] {
  const ctx: CopyContext = { targetRoot: dest, skipped, alwaysOwned: true };
  const missing: string[] = [];
  for (const name of VENDORED_DEPENDENCIES) {
    const src = findDependency(packageRoot, name);
    if (!src) {
      missing.push(name);
      continue;
    }
    copyRecursive(src, path.join(dest, 'node_modules', name), ctx);
  }
  return missing;
}

// Copies glafka into .glafka/, so each project gets its own fixed copy. We copy the built .js, not the TypeScript, so no build step is needed.
// Left in the vendored folder itself, because that is where an agent looking
// for a way around a broken command actually arrives.
const INTERNAL_NOTICE = `# .glafka — glafka's own code

**Do not read, import or call anything in here.** It is machinery, not an API.
It is vendored so the commands can run, nothing more.

Use the command line:

    node .glafka/bin/glafka.js <command>

The modules under \`src/\` write the files a person is supposed to approve
first — proposed conventions, the rules a project is then held to. Calling one
directly writes those files with nobody's approval behind them.

**If a glafka command fails, stop and report it.** Do not find another way to
get the same result. A broken command is worth one line; routing around it
writes data no one checked, and no one finds out.
`;

// Every skill doc, and glafkaCli(), spell the entry point as .glafka/bin/glafka.js.
// The real file moved a level down with installKit, so this keeps that path true.
function writeEntryShim(dest: string): void {
  const binDir = path.join(dest, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(binDir, 'glafka.js'),
    `#!/usr/bin/env node\n// Entry point. The code lives in ../${KIT}/bin/glafka.js.\nimport '../${KIT}/bin/glafka.js';\n`,
  );
}

function vendorCli(
  packageRoot: string,
  targetRoot: string,
  skipped: string[],
): { version: string; missingDependencies: string[] } {
  const ctx: CopyContext = { targetRoot, skipped, alwaysOwned: true };
  const dest = path.join(targetRoot, '.glafka');
  const distSrc = path.join(packageRoot, 'dist');
  // The vendored tree keeps dist's shape. Flattening installKit/bin into .glafka/bin
  // would move it one level closer to src/, and every ../../src import inside it
  // would resolve outside .glafka entirely.
  copyRecursive(path.join(distSrc, KIT, 'bin'), path.join(dest, KIT, 'bin'), ctx);
  copyRecursive(path.join(distSrc, 'src'), path.join(dest, 'src'), ctx);
  const guardrailsSrc = path.join(distSrc, KIT, 'guardrails');
  if (fs.existsSync(guardrailsSrc))
    copyRecursive(guardrailsSrc, path.join(dest, KIT, 'guardrails'), ctx);
  // The personas path is relative to the CLI folder.
  // Skip this copy and personas break with no message.
  const personasSrc = path.join(packageRoot, KIT, 'personas');
  if (fs.existsSync(personasSrc)) copyRecursive(personasSrc, path.join(dest, KIT, 'personas'), ctx);
  // Same reason: `--with-standards` reads these off the package root, and for a project running the
  // vendored CLI that root is `.glafka/`. Left out, the flag would find nothing and seed nothing,
  // with no error to explain it.
  for (const name of ['standards', 'ethos-seed']) {
    const src = path.join(packageRoot, KIT, name);
    if (fs.existsSync(src)) copyRecursive(src, path.join(dest, KIT, name), ctx);
  }
  writeEntryShim(dest);
  const missingDependencies = vendorDependencies(packageRoot, dest, skipped);
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(path.join(packageRoot, 'package.json'), path.join(dest, 'package.json'));

  // A plain text version file, so you can read the version at a glance.
  const { version } = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(dest, 'VERSION'), `${version}\n`);
  // An agent that opens this folder finds the modules that write ethos files.
  // Say plainly they are not an API, since nothing else here does.
  fs.writeFileSync(path.join(dest, 'README.md'), INTERNAL_NOTICE);
  return { version, missingDependencies };
}

// `.env.glafka` too: if the base branch does not ignore it, every ticket's PR
// carries an extra commit that only edits .gitignore. `.elaia/` holds the Elaia panel's chats.
const IGNORED_PATHS = ['.glafka/', '.worktrees/', TICKET_ENV_FILE, '.elaia/'];

// Only adds the missing lines. It never changes lines that are there.
function ensureGitignored(targetRoot: string): void {
  const gitignorePath = path.join(targetRoot, '.gitignore');
  const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
  const lines = existing.split('\n').map((line) => line.trim());
  const missing = IGNORED_PATHS.filter((entry) => !lines.includes(entry));
  if (missing.length === 0) return;
  const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(gitignorePath, `${existing}${separator}${missing.join('\n')}\n`);
}

// Installs the program, the skill docs, and each tool's folder.
// Run it again to upgrade. There is no default: the caller names the platforms.
export function install({
  packageRoot,
  targetRoot,
  platforms,
}: {
  packageRoot: string;
  targetRoot: string;
  platforms: string[];
}): {
  installed: string[];
  platforms: string[];
  version: string;
  skipped: string[];
  missingDependencies: string[];
} {
  const requested = platforms.includes('all') ? KNOWN_PLATFORMS : platforms;
  const unknown = requested.filter((p) => !KNOWN_PLATFORMS.includes(p as Platform));
  if (unknown.length > 0) {
    throw new Error(
      `unknown platform(s): ${unknown.join(', ')} (known: ${KNOWN_PLATFORMS.join(', ')})`,
    );
  }
  // We checked every name above, so this cast is only for the compiler.
  const wanted = requested as Platform[];

  const installed = [];
  // Only the tools we really installed. Another file needs this list.
  const platformsInstalled = [];

  const skipped: string[] = [];
  const ctx: CopyContext = { targetRoot, skipped };
  const { version, missingDependencies } = vendorCli(packageRoot, targetRoot, skipped);
  ensureGitignored(targetRoot);
  installed.push('.glafka (vendored)');

  const skillsSrc = path.join(packageRoot, KIT, 'skills');
  if (fs.existsSync(skillsSrc)) {
    copyRecursive(skillsSrc, path.join(targetRoot, 'docs', 'glafka', 'skills'), ctx);
    installed.push('docs/glafka/skills');
  }

  for (const platform of wanted) {
    const dir = PLATFORM_DIRS[platform];
    const src = path.join(packageRoot, KIT, dir);
    if (!fs.existsSync(src)) continue;
    copyRecursive(src, path.join(targetRoot, dir), ctx);
    installed.push(dir);
    platformsInstalled.push(platform);

    for (const extraDir of EXTRA_PLATFORM_DIRS[platform] ?? []) {
      const extraSrc = path.join(packageRoot, KIT, extraDir);
      if (!fs.existsSync(extraSrc)) continue;
      copyRecursive(extraSrc, path.join(targetRoot, extraDir), ctx);
      installed.push(extraDir);
    }
  }

  return { installed, platforms: platformsInstalled, version, skipped, missingDependencies };
}
