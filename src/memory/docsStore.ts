import fs from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';
import { writeFile } from '../util/fileOperations.js';
import {
  IsolationProfileSchema,
  WorkspaceSchema,
  type IsolationProfile,
  type Workspace,
} from '../types/isolationProfile.js';

// We join the messages ourselves. The built-in one wraps them in JSON,
// which turns our own quotes into backslash escapes.
function describeParseError(error: z.ZodError): string {
  return error.issues.map((issue) => issue.message).join('; ');
}

// Where the docs live in git. Other files use this too.
export const DOCS_ROOT = 'docs/glafka';

// One file per category.
export function ethosPath(repoRoot: string, target: string): string {
  return path.join(repoRoot, DOCS_ROOT, 'ethos', `${target}.md`);
}

// Top-level index only.
export function architectureIndexPath(repoRoot: string): string {
  return path.join(repoRoot, DOCS_ROOT, 'architecture', 'README.md');
}

export function architectureDir(repoRoot: string): string {
  return path.join(repoRoot, DOCS_ROOT, 'architecture');
}

// When the map was last built. A sidecar, so the agent's markdown is never
// edited by us and never has to be parsed.
export function architectureStampPath(repoRoot: string): string {
  return path.join(architectureDir(repoRoot), 'scan.json');
}

export function readArchitectureStamp(repoRoot: string): { commit: string } | null {
  const filePath = architectureStampPath(repoRoot);
  if (!fs.existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readDoc(filePath)) as { commit?: unknown };
    return typeof parsed.commit === 'string' ? { commit: parsed.commit } : null;
  } catch {
    // A hand-mangled stamp reads as "never scanned", which is the safe answer.
    return null;
  }
}

export function writeArchitectureStamp(repoRoot: string, commit: string): void {
  const stamp = { commit, at: new Date().toISOString() };
  writeDoc(architectureStampPath(repoRoot), `${JSON.stringify(stamp, null, 2)}\n`);
}

// How many docs a scan left behind. glafka reports this itself so the
// agent has no reason to write its own summary of the run.
export function countArchitectureDocs(repoRoot: string): number {
  const walk = (dir: string): number => {
    if (!fs.existsSync(dir)) return 0;
    let found = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) found += walk(path.join(dir, entry.name));
      else if (entry.name.endsWith('.md')) found += 1;
    }
    return found;
  };
  return walk(architectureDir(repoRoot));
}

export function writeDoc(filePath: string, content: string): void {
  writeFile(filePath, content);
}

export function readDoc(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}

// Null when the scan has not run yet.
export function readArchitectureIndex(repoRoot: string): string | null {
  const filePath = architectureIndexPath(repoRoot);
  return fs.existsSync(filePath) ? readDoc(filePath) : null;
}

// A person writes this file. We only read it.
export function proorismosPath(repoRoot: string): string {
  return path.join(repoRoot, DOCS_ROOT, 'proorismos.md');
}

// Where a project keeps its own personas. Git-tracked, so a team shares them — unlike the vendored
// .glafka/personas/, which is git-ignored and dies with a fresh clone.
export function projectPersonasDir(repoRoot: string): string {
  return path.join(repoRoot, DOCS_ROOT, 'personas');
}

// Null if nobody wrote one. That is fine, it is optional.
export function readProorismos(repoRoot: string): string | null {
  const filePath = proorismosPath(repoRoot);
  return fs.existsSync(filePath) ? readDoc(filePath) : null;
}

// Only for projects that run a server or a database.
export function isolationProfilePath(repoRoot: string): string {
  return path.join(repoRoot, DOCS_ROOT, 'architecture', 'isolation.json');
}

// Null when the scan found none, or the project needs none.
export function readIsolationProfile(repoRoot: string): IsolationProfile | null {
  const filePath = isolationProfilePath(repoRoot);
  if (!fs.existsSync(filePath)) return null;

  const result = IsolationProfileSchema.safeParse(JSON.parse(readDoc(filePath)));
  if (!result.success) throw new Error(`${filePath}: ${describeParseError(result.error)}`);
  return result.data;
}

// Where the scan leaves its findings, until a person decides.
export function workspaceProposalPath(repoRoot: string): string {
  return path.join(repoRoot, DOCS_ROOT, 'architecture', 'workspace.proposed.json');
}

// Where a decided proposal is parked. Out of the way of `--list`, but still
// readable, so a setting turned down by mistake is not gone for good.
export function workspaceDecidedPath(repoRoot: string): string {
  return path.join(repoRoot, DOCS_ROOT, 'architecture', 'workspace.decided.json');
}

export function readWorkspaceProposal(repoRoot: string): Workspace | null {
  const filePath = workspaceProposalPath(repoRoot);
  if (!fs.existsSync(filePath)) return null;

  const result = WorkspaceSchema.safeParse(JSON.parse(readDoc(filePath)));
  if (!result.success) throw new Error(`${filePath}: ${describeParseError(result.error)}`);
  return result.data;
}

interface WorkspaceAtom {
  label: string;
  apply: (workspace: Workspace) => void;
  // Set only on the checks one, so glafka can test the command a person kept.
  checksCmd?: string;
}

// One decision per line, so a human can reject one without rejecting all.
export function workspaceAtoms(proposal: Workspace | null): WorkspaceAtom[] {
  if (!proposal) return [];
  const atoms: WorkspaceAtom[] = [];
  if (proposal.baseRef) {
    const baseRef = proposal.baseRef;
    atoms.push({
      label: `base branch: ${baseRef}`,
      apply: (w) => {
        w.baseRef = baseRef;
      },
    });
  }
  for (const relative of proposal.submodules?.paths ?? []) {
    atoms.push({
      label: `init submodule: ${relative}`,
      apply: (w) => {
        w.submodules ??= {};
        w.submodules.paths ??= [];
        if (!w.submodules.paths.includes(relative)) w.submodules.paths.push(relative);
      },
    });
  }
  if (proposal.submodules?.branchPerTicket) {
    atoms.push({
      label: 'give each ticket its own branch inside every submodule',
      apply: (w) => {
        w.submodules ??= {};
        w.submodules.branchPerTicket = true;
      },
    });
  }
  if (proposal.bootstrapCmd) {
    const bootstrapCmd = proposal.bootstrapCmd;
    atoms.push({
      label: `bootstrap: ${bootstrapCmd}`,
      apply: (w) => {
        w.bootstrapCmd = bootstrapCmd;
      },
    });
  }
  // Kept apart, so saying yes to checks does not also say yes to e2e.
  if (proposal.checksCmd) {
    const checksCmd = proposal.checksCmd;
    atoms.push({
      label: `run checks with: ${checksCmd}`,
      apply: (w) => {
        w.checksCmd = checksCmd;
      },
      checksCmd,
    });
  }
  if (proposal.e2eCmd) {
    const e2eCmd = proposal.e2eCmd;
    atoms.push({
      label: `run e2e with: ${e2eCmd}`,
      apply: (w) => {
        w.e2eCmd = e2eCmd;
      },
    });
  }
  for (const relative of proposal.seedFiles ?? []) {
    atoms.push({
      label: `copy local-only file into each worktree: ${relative}`,
      apply: (w) => {
        w.seedFiles ??= [];
        if (!w.seedFiles.includes(relative)) w.seedFiles.push(relative);
      },
    });
  }
  return atoms;
}

// Saves the findings you kept and parks the list,
// so nothing is decided twice but nothing is lost either.
export function applyWorkspaceDecision(
  repoRoot: string,
  keptIndexes: number[],
): { applied: string[]; profileWritten: boolean; keptChecksCmd: string | null } {
  const proposal = readWorkspaceProposal(repoRoot);
  if (!proposal) return { applied: [], profileWritten: false, keptChecksCmd: null };

  const atoms = workspaceAtoms(proposal);
  const kept = keptIndexes
    .map((n) => atoms[n - 1])
    .filter((atom): atom is WorkspaceAtom => Boolean(atom));

  if (kept.length > 0) {
    const profilePath = isolationProfilePath(repoRoot);
    const profile: IsolationProfile = fs.existsSync(profilePath)
      ? (JSON.parse(readDoc(profilePath)) as IsolationProfile)
      : {};
    profile.workspace ??= {};
    for (const atom of kept) atom.apply(profile.workspace);
    const result = IsolationProfileSchema.safeParse(profile);
    if (!result.success) throw new Error(`${profilePath}: ${describeParseError(result.error)}`);
    writeDoc(profilePath, `${JSON.stringify(profile, null, 2)}\n`);
  }

  // Moved, not deleted. `--list` stops offering it, and the settings you turned
  // down are still on disk to re-apply if the pick was wrong.
  fs.renameSync(workspaceProposalPath(repoRoot), workspaceDecidedPath(repoRoot));
  return {
    applied: kept.map((atom) => atom.label),
    profileWritten: kept.length > 0,
    keptChecksCmd: kept.find((atom) => atom.checksCmd)?.checksCmd ?? null,
  };
}
