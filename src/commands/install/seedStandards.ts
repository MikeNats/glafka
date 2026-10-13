import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { seedAuthoredRules } from '../../memory/ethos.js';
import { standardsDir, STANDARDS_FILES, STANDARDS_DIR } from '../../memory/standards.js';
import { KIT } from './install.js';

// `glafka install --with-standards`. Opt-in, and it is the ONLY thing that writes either of these
// two places — a plain install, and `--all`, still change nothing here.
//
// The two halves are written differently on purpose:
//
//   docs/glafka/standards/  OVERWRITTEN — glafka's text. It lives under docs/, which is tracked, so
//                           `git diff` is the undo. Same deal docs/glafka/skills/ already runs on.
//   docs/glafka/ethos/      APPENDED    — the project's own rules and glafka's captured `## Learned`
//                           rules live in those files. Overwriting would delete both.

export const SEED_DIRS = Object.freeze({ standards: 'standards', ethos: 'ethos-seed' });

export interface SeedResult {
  lanes: string[];
  ethos: { target: string; added: number; skipped: number }[];
  // Lane files left alone because they had uncommitted edits. Empty is the normal case.
  blocked: string[];
}

// Where the shipped copies live. Two layouts, same reason findPackageRoot has two: inside the
// published package everything sits under installKit/, and an installed project flattens it.
function shippedDir(packageRoot: string, name: string): string {
  const inKit = path.join(packageRoot, KIT, name);
  return fs.existsSync(inKit) ? inKit : path.join(packageRoot, name);
}

// Whether a tracked file has edits that are not committed yet. `git diff` is only an undo for work
// that is committed, so an overwrite here really would destroy something. Any git failure — not a
// repo, git missing — answers "no": this is a safety check, not a gate, and it must never be the
// reason an install cannot run.
function hasUncommittedChanges(repoRoot: string, relative: string): boolean {
  try {
    const out = execFileSync('git', ['status', '--porcelain', '--', relative], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim() !== '';
  } catch {
    return false;
  }
}

// Reads one seed file into its bullet lines. The shipped files are plain lists — one rule per line,
// starting with "- " — so the same text can be read by a person without a parser in the way.
function rulesOf(filePath: string): string[] {
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.match(/^- (.+)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => m[1]!.trim())
    .filter(Boolean);
}

export function seedStandards({
  repoRoot,
  packageRoot,
}: {
  repoRoot: string;
  packageRoot: string;
}): SeedResult {
  const result: SeedResult = { lanes: [], ethos: [], blocked: [] };

  // ---- the lanes, reviewer-only
  const laneSrc = shippedDir(packageRoot, SEED_DIRS.standards);
  if (fs.existsSync(laneSrc)) {
    const dest = standardsDir(repoRoot);
    fs.mkdirSync(dest, { recursive: true });
    for (const name of STANDARDS_FILES) {
      const from = path.join(laneSrc, name);
      if (!fs.existsSync(from)) continue;
      const relative = `${STANDARDS_DIR}/${name}`;
      if (fs.existsSync(path.join(dest, name)) && hasUncommittedChanges(repoRoot, relative)) {
        result.blocked.push(relative);
        continue;
      }
      fs.copyFileSync(from, path.join(dest, name));
      result.lanes.push(relative);
    }
  }

  // ---- the short rules, coder + reviewer
  const ethosSrc = shippedDir(packageRoot, SEED_DIRS.ethos);
  if (fs.existsSync(ethosSrc)) {
    const byTarget = new Map<string, string[]>();
    for (const file of fs.readdirSync(ethosSrc)) {
      if (!file.endsWith('.md')) continue;
      // The filename IS the category name, so the mapping needs no table to fall out of date.
      const rules = rulesOf(path.join(ethosSrc, file));
      if (rules.length > 0) byTarget.set(`ETHOS_${path.basename(file, '.md')}`, rules);
    }
    result.ethos = seedAuthoredRules(repoRoot, byTarget);
  }

  return result;
}
