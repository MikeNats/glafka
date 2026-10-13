import fs from 'node:fs';
import path from 'node:path';
import { createWorktree, commitFile, currentBranch, headCommit } from '../../util/git.js';
import { recordBaseline } from '../../checksBaseline.js';
import { readIsolationProfile } from '../../memory/docsStore.js';
import { listTickets } from '../ticketStore.js';
import {
  worktreePath,
  listProvisioning,
  isStaleProvisioningLock,
  portsLockPath,
} from '../paths.js';
import { withFileLockAsync } from '../../util/fileOperations.js';
import { HOOK_CONFIG_PATHS } from '../../../installKit/guardrails/index.js';
import {
  DEFAULT_ISOLATION_HOOK_TIMEOUT_MS,
  runBootstrap,
  runIsolationHook,
  prepareSubmodules,
  seedFiles,
} from './isolationHooks.js';
import type { PortRange } from './ports.js';
import { findFreePort } from './ports.js';
import { servicesOf, envFor, ensureEnvIgnored, TICKET_ENV_FILE } from './ticketEnv.js';
import type { IsolationProfileLike } from './ticketEnv.js';
import { ensureDevServer, reportDevServer, ticketPorts } from '../devServer.js';
import { releaseResources } from './release.js';

// A worktree only sees committed files, so an uncommitted hook file means
// no cage. We only warn, because running with no hook is a valid choice.
function warnIfHookConfigMissing(repoRoot: string, worktree: string): void {
  for (const rel of HOOK_CONFIG_PATHS) {
    if (fs.existsSync(path.join(repoRoot, rel)) && !fs.existsSync(path.join(worktree, rel))) {
      console.error(
        `warning: ${rel} is missing from the new worktree — this ticket's coder runs uncaged for that harness. ` +
          `Check it's committed on the branch this ticket was cut from (glafka guardrails --install-hook).`,
      );
    }
  }
}

// The branch is the ticket's name. The name already carries the date and the
// idea, so there is nothing left to add.
export function buildBranchName(id: string): string {
  return `glafka/${id}`;
}

interface AcquiredPorts {
  port: number | null;
  isolationPorts: Record<string, number> | null;
  env: Record<string, string>;
}

// One port per service. `skip` grows as we go, so two services in one
// ticket never get the same port.
async function acquirePorts(
  profile: IsolationProfileLike | null | undefined,
  portRange: PortRange | undefined,
  alreadyAssigned: number[],
): Promise<AcquiredPorts> {
  // No services means one port only. A profile can exist just to describe
  // `workspace` while the project still runs on a single PORT.
  if (!profile || servicesOf(profile).length === 0) {
    const port = await findFreePort(portRange, { skip: alreadyAssigned });
    return { port, isolationPorts: null, env: { PORT: String(port) } };
  }

  const isolationPorts: Record<string, number> = {};
  let env: Record<string, string> = {};
  const skip = [...alreadyAssigned];
  for (const service of servicesOf(profile)) {
    const port = await findFreePort(portRange, { skip });
    skip.push(port);
    isolationPorts[service.name] = port;
    env = { ...env, ...envFor(service, port) };
  }
  return { port: null, isolationPorts, env };
}

// Ports that other open tickets already hold. The free-port test can miss these, because a claimed port looks free until its server starts.
function assignedPorts(stateDir: string, bootstrapTimeoutMs?: number): number[] {
  const ports: number[] = [];
  const unreadable: string[] = [];
  for (const ticket of listTickets(stateDir, {
    includeClosed: false,
    onUnreadable: (warning) => unreadable.push(warning),
  })) {
    if (ticket.port != null) ports.push(ticket.port);
    for (const port of Object.values(ticket.isolationPorts ?? {})) ports.push(port);
  }
  if (unreadable.length > 0) {
    throw new Error(
      `refusing to assign a port — ${unreadable.length} ticket file(s) could not be read, so ` +
        `the list of ports already in use is incomplete and a new port could collide with a ` +
        `live ticket's:\n` +
        unreadable.map((w) => `  ${w}`).join('\n') +
        `\n  fix or remove the broken ticket file(s), then try again.`,
    );
  }
  // A ticket still being set up has no file yet, so we also read the setup
  // locks. Old locks are skipped, since those ports were never really used.
  for (const entry of listProvisioning(stateDir)) {
    if (isStaleProvisioningLock(entry, { bootstrapTimeoutMs })) continue;
    ports.push(...entry.ports);
  }
  return ports;
}

interface AcquireResourcesArgs {
  repoRoot: string;
  stateDir: string;
  id: string;
  baseRef: string;
  portRange?: PortRange;
  bootstrapTimeoutMs?: number;
  isolationHookTimeoutMs?: number;
  // The branch name, already decided by the caller.
  branch?: string;
  onPortsClaimed?: (ports: number[]) => void;
  // Only for the checks baseline. Null checksCmd is what turns it on: it means
  // glafka is guessing the checks, which is the only case worth a baseline.
  checksCmd?: string | null;
  checksTimeoutMs?: number | null;
  // Called right before each long-running phase (bootstrapCmd, each isolation hook). isStaleProvisioningLock judges a lock against a single
  heartbeat?: () => void;
}

interface AcquiredResources {
  branch: string;
  worktree: string;
  port: number | null;
  isolationPorts: Record<string, number> | null;
}

// Sets up everything a ticket needs.
// If a later step fails, it cleans up first, then throws again.
export async function acquireResources({
  repoRoot,
  stateDir,
  id,
  baseRef,
  branch: branchArg,
  portRange,
  bootstrapTimeoutMs,
  isolationHookTimeoutMs = DEFAULT_ISOLATION_HOOK_TIMEOUT_MS,
  // Both only for the checks baseline below.
  checksCmd = null,
  checksTimeoutMs = null,
  // Called as soon as ports are picked, long before this function returns,
  // so another ticket sees them as taken right away.
  onPortsClaimed = () => {},
  heartbeat = () => {},
}: AcquireResourcesArgs): Promise<AcquiredResources> {
  const branch = branchArg ?? buildBranchName(id);
  // Its own top-level folder. A worktree is a full checkout, not metadata.
  const worktree = worktreePath(repoRoot, id);

  // Declared outside the try, so a later failure can still clean up with the
  // real ports instead of null, which would skip teardownCmd.
  let isolationPorts: Record<string, number> | null = null;
  // createWorktree is INSIDE the try. Above it, a throw from the branch check or
  // readIsolationProfile leaked the checkout and its branch.
  try {
    createWorktree(repoRoot, { branch, worktreeDir: worktree, baseRef });
    // What git actually checked out must be the name we are about to store. A mismatch here is
    // unrecoverable later: epistle pushes a branch that does not exist, and findOrphans force-deletes the one that does.
    const actual = currentBranch(worktree);
    if (actual !== branch) {
      throw new Error(
        `ticket ${id}: asked git for branch "${branch}" but the worktree is on "${actual}" — ` +
          `refusing to record a name that does not match the checkout`,
      );
    }
    warnIfHookConfigMissing(repoRoot, worktree);

    const profile = readIsolationProfile(repoRoot) as IsolationProfileLike | null;
    const workspace = profile?.workspace ?? {};

    // Only git so far. A failure here is cleaned up by removeWorktree below.
    prepareSubmodules(repoRoot, worktree, { workspace, branch });

    // Before bootstrap: install may need .env for proxies or tokens.
    seedFiles(repoRoot, worktree, workspace.seedFiles);

    // Gathering the skip list, probing for a free port, and durably recording the claim (onPortsClaimed) all happen as one step. Without
    const acquired = await withFileLockAsync(portsLockPath(stateDir), async () => {
      const result = await acquirePorts(
        profile,
        portRange,
        assignedPorts(stateDir, bootstrapTimeoutMs),
      );
      onPortsClaimed(
        result.isolationPorts
          ? Object.values(result.isolationPorts)
          : result.port != null
            ? [result.port]
            : [],
      );
      return result;
    });
    isolationPorts = acquired.isolationPorts;
    const { port, env } = acquired;

    const envLines = Object.entries(env).map(([k, v]) => `${k}=${v}`);
    envLines.push(`GLAFKA_TICKET_ID=${id}`);

    // Hooks and bootstrap both get these, so a script can find files
    // that are not committed.
    const hookEnv = {
      ...env,
      GLAFKA_TICKET_ID: id,
      GLAFKA_REPO_ROOT: repoRoot,
      GLAFKA_WORKTREE: worktree,
    };

    // Before setupCmd, because setupCmd often needs tools from the install.
    if (workspace.bootstrapCmd) {
      heartbeat();
      runBootstrap(workspace.bootstrapCmd, {
        cwd: worktree,
        env: hookEnv,
        timeout: bootstrapTimeoutMs,
      });
    }

    if (profile) {
      // In order: setupCmd makes the database, seedCmd fills it, e2e gets its own.
      for (const [label, cmd] of [
        ['setupCmd', profile.setupCmd],
        ['seedCmd', profile.seedCmd],
        ['e2e.setupCmd', profile.e2e?.setupCmd],
      ] as const) {
        if (!cmd) continue;
        heartbeat();
        // The hook can print KEY=VALUE lines, like a DATABASE_URL.
        const extra = runIsolationHook(cmd, {
          cwd: worktree,
          env: hookEnv,
          timeout: isolationHookTimeoutMs,
          label,
        });
        envLines.push(...Object.entries(extra).map(([k, v]) => `${k}=${v}`));
        // Each hook sees what the ones before it printed. Seeding needs the
        // connection string setupCmd just produced, and could not reach it.
        Object.assign(hookEnv, extra);
      }
    }

    const wroteGitignore = ensureEnvIgnored(worktree);
    fs.writeFileSync(path.join(worktree, TICKET_ENV_FILE), `${envLines.join('\n')}\n`);

    // Committed so the worktree starts clean. If not, ergon's dirty check
    // would read this as unfinished agent work.
    if (wroteGitignore) {
      commitFile(worktree, '.gitignore', "glafka: ignore .env.glafka in this ticket's worktree");
    }

    // AFTER the .gitignore commit, not before, and the ordering is the whole point.
    // `planCommit` — the key ergon reads the baseline back under — is
    // `headCommit(worktree)` taken by genesis once this function returns, so it is the sha of that
    // commit. Recording under the sha from before it meant the lookup never hit and the baseline
    // was dead weight in every project that did not already ignore `.env.glafka`. The tree still holds base code and its installed dependencies — the commit above only
    // touches `.gitignore` — so the result is the same, and it is now taken on exactly the tree the
    // coder starts from. No-ops when `checksCmd` is set, when a baseline for this commit already
    // exists, and on any error — it is an optimisation, never a gate.
    await recordBaseline({
      stateDir,
      worktree,
      commit: headCommit(worktree),
      checksCmd,
      checksTimeoutMs,
      // Only stamped if it really runs the checks, never for the no-op.
      heartbeat,
      // Said out loud, because this runs the project's own test suite and
      // nothing else here takes minutes in silence.
      onStart: (names) =>
        console.error(
          `recording a checks baseline for ${headCommit(worktree).slice(0, 7)} (${names.join(', ')}) — ` +
            `no "checksCmd" is configured, so glafka is running the scripts package.json defines, once, ` +
            `to learn which were already failing before this ticket. Set "checksCmd" in .glafka.json to skip this.`,
        ),
    });

    // The worktree is complete now, so the app has everything it needs. Its
    // own failures are reported, never thrown: the ticket is not rolled back.
    try {
      const devTicket = { id, worktree, isolationPorts, port };
      const outcome = await ensureDevServer({ stateDir, repoRoot, ticket: devTicket, profile });
      reportDevServer(outcome, { stateDir, id, ports: ticketPorts(devTicket) });
    } catch (err) {
      console.error(`warning: the app could not be started for ${id}: ${(err as Error).message}`);
    }

    return { branch, worktree, port, isolationPorts };
  } catch (err) {
    // Try to clean up, but never let that hide the first error.
    // Uses the real ports, so teardownCmd still runs the right way.
    try {
      await releaseResources({
        repoRoot,
        stateDir,
        ticket: { id, branch, worktree, isolationPorts },
        isolationHookTimeoutMs,
        discardBranch: true,
      });
    } catch {
      // Cleanup failed or had nothing to do. The first error still matters most.
    }
    throw err;
  }
}
