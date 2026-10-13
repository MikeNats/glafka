import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { writeFile } from './util/fileOperations.js';
import { runChecks, guessableChecks } from './checks.js';
import type { RunFn } from './checks.js';
import type { CheckResult } from './types/checks.js';

// Which of glafka's GUESSED checks were already failing on the base commit, before any ticket
// touched it. glafka has one zero-config fallback: if `package.json` defines `lint`, `typecheck` or
// `test`, it runs them. Nobody configured those, and a project can sit for months with a red `lint`
// script nobody uses. When one of them fails on a ticket branch, glafka used to send the coder back
// to fix it — three times, at `maxReviewRounds` — for code the coder never wrote and cannot fix.
// The baseline is the answer to "was this already broken?". It is recorded once
// per base commit, so every ticket cut from the same commit reuses it, and only for projects that
// never set `checksCmd` — configuring the real command is the recommended path and skips all of
// this.

const BaselineSchema = z.object({
  commit: z.string(),
  // Check names that failed on the base commit itself.
  failing: z.array(z.string()),
  at: z.string(),
});
export type ChecksBaseline = z.infer<typeof BaselineSchema>;

function baselineDir(stateDir: string): string {
  return path.join(stateDir, 'baselines');
}

// Keyed by commit, so a ticket cut from an older base still reads its own.
function baselinePath(stateDir: string, commit: string): string {
  // A commit sha is hex from git, but this builds a path, so refuse anything
  // that is not one rather than trusting the caller.
  if (!/^[0-9a-f]{7,64}$/i.test(commit)) throw new Error(`not a commit sha: "${commit}"`);
  return path.join(baselineDir(stateDir), `${commit}.json`);
}

export function readBaseline(stateDir: string, commit: string): ChecksBaseline | null {
  let filePath: string;
  try {
    filePath = baselinePath(stateDir, commit);
  } catch {
    return null;
  }
  if (!fs.existsSync(filePath)) return null;
  try {
    return BaselineSchema.parse(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch {
    // A baseline is an optimisation, never a source of truth. An unreadable
    // one means "unknown", which is the same as not having it.
    return null;
  }
}

export function writeBaseline(stateDir: string, baseline: ChecksBaseline): void {
  fs.mkdirSync(baselineDir(stateDir), { recursive: true });
  writeFile(baselinePath(stateDir, baseline.commit), `${JSON.stringify(baseline, null, 2)}\n`);
}

// Records the baseline for `commit`, by running the guessed checks in a worktree that is still AT
// that commit. Called once, right after a ticket's worktree is provisioned and bootstrapped — that
// is the only moment the tree holds the base commit and its dependencies at the same time, which is
// what makes this cheap enough to do at all. Skipped entirely when `checksCmd` is set: then nothing
// is guessed, a failure is the project's own command failing, and the coder should fix it.
export async function recordBaseline({
  stateDir,
  worktree,
  commit,
  checksCmd,
  checksTimeoutMs = null,
  run,
  heartbeat = () => {},
  onStart = () => {},
}: {
  stateDir: string;
  worktree: string;
  commit: string;
  checksCmd: string | null;
  checksTimeoutMs?: number | null;
  run?: RunFn;
  // Called only if this is really about to run checks, so a caller that
  // re-stamps a provisioning lock does not stamp it for a no-op.
  heartbeat?: () => void;
  // Same contract as `heartbeat`: only called when checks are really about to run. It is handed the
  // script names, so the caller can name what it is spending time on rather than going quiet for minutes.
  onStart?: (names: string[]) => void;
}): Promise<ChecksBaseline | null> {
  if (checksCmd) return null;
  if (readBaseline(stateDir, commit)) return null;
  // Asked before anything is spent. Nothing to guess means nothing to
  // baseline, and an empty baseline would claim we know the base is green.
  const willRun = guessableChecks(worktree);
  if (willRun.length === 0) return null;

  heartbeat();
  onStart(willRun);

  let results: CheckResult[];
  try {
    // e2eCmd is deliberately left out: it is never part of the guessed set.
    results = await runChecks(worktree, { run, checksTimeoutMs });
  } catch {
    // Never fail a ticket because the baseline could not be taken.
    return null;
  }
  // Nothing ran means there is nothing to guess about, and writing an empty
  // baseline would claim we know the base is green when we ran no checks.
  if (results.length === 0) return null;

  const baseline: ChecksBaseline = {
    commit,
    failing: results.filter((r) => !r.passed && !r.unknown).map((r) => r.name),
    at: new Date().toISOString(),
  };
  writeBaseline(stateDir, baseline);
  return baseline;
}

export interface FailureSplit {
  // Failures this branch is responsible for. Worth a coder round.
  introduced: string[];
  // Failures the base commit already had. No coder round can fix these.
  preExisting: string[];
}

// Splits a run's failures by who caused them. With no baseline recorded, every failure counts as
// introduced — the old behaviour, which is the safe default: sending the coder at its own bug is never wrong, only sometimes wasteful.
export function splitFailures(
  checks: CheckResult[],
  baseline: ChecksBaseline | null,
): FailureSplit {
  const failed = checks.filter((c) => !c.passed && !c.unknown).map((c) => c.name);
  if (!baseline) return { introduced: failed, preExisting: [] };
  const wasFailing = new Set(baseline.failing);
  return {
    introduced: failed.filter((name) => !wasFailing.has(name)),
    preExisting: failed.filter((name) => wasFailing.has(name)),
  };
}
