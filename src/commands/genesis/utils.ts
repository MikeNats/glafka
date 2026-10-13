import { headCommit } from '../../util/git.js';
import { writeTicket, readTicket, recordStage, withTicketLock } from '../../ticket/ticketStore.js';
import {
  acquireResources,
  releaseResources,
  releaseGitResources,
  buildBranchName,
} from '../../ticket/resources.js';
import { stopDevServerNow } from '../../ticket/devServer.js';
import { writeDoc } from '../../memory/docsStore.js';
import {
  specPath as specDocPath,
  planPath as planDocPath,
  worktreePath,
  writeProvisioningLock,
  removeProvisioningLock,
} from '../../ticket/paths.js';
import { pinFor } from '../../../installKit/guardrails/index.js';
import type { Ticket, Stage } from '../../types/ticket.js';

// Sets up a ticket: worktree, branch, ports, spec and plan.
// If a later step fails, it cleans up what it made.
export async function provisionTicket({
  repoRoot,
  stateDir,
  id,
  title,
  content,
  created,
  stage,
  baseRef,
  planContent = null,
  portRange = undefined,
  bootstrapTimeoutMs = undefined,
  isolationHookTimeoutMs = undefined,
  // Only for the checks baseline. A set checksCmd turns it off: nothing is
  // guessed then, so there is nothing to be careful about.
  checksCmd = null,
  checksTimeoutMs = null,
}: {
  repoRoot: string;
  stateDir: string;
  id: string;
  title: string | null;
  content: string;
  created: string;
  stage: Stage;
  baseRef: string;
  planContent?: string | null;
  portRange?: { start: number; end: number };
  bootstrapTimeoutMs?: number;
  isolationHookTimeoutMs?: number;
  checksCmd?: string | null;
  checksTimeoutMs?: number | null;
}): Promise<Ticket> {
  // Setup can take minutes, and until it ends there is no ticket file.
  // This lock stops a cleanup run treating the new files as leftovers.
  const branch = buildBranchName(id);
  const pid = process.pid;
  writeProvisioningLock(stateDir, id, { branch, pid, startedAt: Date.now() });

  // Re-stamped at each long-running phase boundary (see resources.ts's heartbeat comment) — isStaleProvisioningLock judges this lock against
  let lastPorts: number[] = [];
  const restampLock = () =>
    writeProvisioningLock(stateDir, id, {
      branch,
      ports: lastPorts,
      pid,
      startedAt: Date.now(),
    });

  const stopSignalCleanup = cleanUpOnSignal({ repoRoot, stateDir, id, branch });

  try {
    const { worktree, port, isolationPorts } = await acquireResources({
      repoRoot,
      stateDir,
      id,
      baseRef,
      // The same name the provisioning lock records. Computed once, above.
      branch,
      portRange,
      bootstrapTimeoutMs,
      isolationHookTimeoutMs,
      checksCmd,
      checksTimeoutMs,
      onPortsClaimed: (ports) => {
        lastPorts = ports;
        restampLock();
      },
      heartbeat: restampLock,
    });

    try {
      const specPath = specDocPath(repoRoot, id);
      writeDoc(specPath, content);

      let planPath: string | null = null;
      let planCommit: string | null = null;
      if (planContent) {
        planPath = planDocPath(repoRoot, id);
        writeDoc(planPath, planContent);
        // The starting commit. Progress is counted from here.
        planCommit = headCommit(worktree);
      }

      // Locked read-modify-write — on an existing ticket (plan) we read it first, so its old fields survive; the
      withTicketLock(stateDir, id, () => {
        // On an existing ticket we read it first, so its old fields survive.
        // On a brand new one there is nothing to read yet.
        let existing: Ticket | null = null;
        try {
          existing = readTicket(stateDir, id);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }

        const now = new Date().toISOString();
        writeTicket(stateDir, {
          ...(existing ?? {}),
          id,
          title,
          branch,
          worktree,
          specText: content,
          specPath,
          planPath,
          port,
          isolationPorts,
          planCommit,
          created,
          updated: now,
          // Save the guardrails now. Later steps refuse if they change. Hashed from the worktree's own copy of the hook configs, since
          guardrails: pinFor({ repoRoot, worktree, now }),
        });
      });
      recordStage(stateDir, id, stage);
      // Read it again, because the stage log is only added when we read.
      return readTicket(stateDir, id);
    } catch (err) {
      // Try to clean up, but never hide the first error.
      try {
        // Setup may have started the app. `stateDir` is what stops it, before
        // the worktree it runs in is removed.
        await releaseResources({
          repoRoot,
          stateDir,
          ticket: { id, branch, worktree, isolationPorts },
          isolationHookTimeoutMs,
          // Setup never finished, so the branch holds nothing. It must go, or a
          // retry hits `git worktree add -b` on a name that already exists.
          discardBranch: true,
        });
      } catch {
        // Ignore this. The first error matters more.
      }
      throw err;
    }
  } finally {
    // Setup is over either way, whether it worked or not.
    stopSignalCleanup();
    removeProvisioningLock(stateDir, id);
  }
}

// A signal is not a throw, so the catch above never ran and Ctrl-C during the
// minutes of setup stranded a 120MB checkout. Returns the handler remover.
function cleanUpOnSignal({
  repoRoot,
  stateDir,
  id,
  branch,
}: {
  repoRoot: string;
  stateDir: string;
  id: string;
  branch: string;
}): () => void {
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  let cleaning = false;

  const onSignal = (signal: NodeJS.Signals) => {
    // A second Ctrl-C means "stop now". Re-raise with our handler already gone,
    // so the default one ends the process instead of cleaning twice.
    if (cleaning) {
      remove();
      process.kill(process.pid, signal);
      return;
    }
    cleaning = true;
    console.error(`\n${signal} during setup for ${id} — removing its worktree and branch.`);
    try {
      // Ctrl-C leaves the app running, detached, on ports this ticket is about
      // to give back. SIGTERM alone left a deaf one behind, so this escalates.
      stopDevServerNow({ stateDir, id });
      // The synchronous half only. teardownCmd is skipped on purpose: it can take
      // minutes, and the person pressing Ctrl-C is asking for this to stop.
      releaseGitResources({
        repoRoot,
        ticket: { id, branch, worktree: worktreePath(repoRoot, id) },
        discardBranch: true,
      });
      removeProvisioningLock(stateDir, id);
      console.error(`cleaned up ${id}.`);
    } catch (err) {
      // Say what is left rather than dying silently on the way out.
      console.error(
        `could not finish cleaning up ${id}: ${(err as Error).message}\n` +
          `  run: glafka lysis ${id} --sweep`,
      );
    }
    // Anything setupCmd started is still running, and only the project knows how
    // to stop it. Said plainly, because nothing else will say it.
    console.error('note: teardownCmd was not run — stop any services it started by hand.');
    remove();
    process.kill(process.pid, signal);
  };

  const remove = () => {
    for (const signal of signals) process.removeListener(signal, onSignal);
  };

  for (const signal of signals) process.on(signal, onSignal);
  return remove;
}
