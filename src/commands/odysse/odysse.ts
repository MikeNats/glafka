import { formatFileTree } from '../../util/fileOperations.js';
import { glafkaCli } from '../../util/cli.js';
import { listProjectFiles } from '../../util/git.js';
import { loadCategories } from '../../memory/categories.js';
import { readProposals, decideProposals } from '../../memory/ethos.js';
import type { EthosProposal } from '../../memory/ethos.js';
import fs from 'node:fs';
import {
  applyWorkspaceDecision,
  countArchitectureDocs,
  isolationProfilePath,
} from '../../memory/docsStore.js';
import { parseKeepArg } from '../../memory/ethosGate.js';
import { readWorkspaceProposalListing } from './utils.js';
import {
  buildOdysseFullPrompt,
  buildOdysseUpdatePrompt,
  buildChecksProbePrompt,
} from './prompts.js';

// The whole-repo prompt. Run it once, or to refresh.
// Do not run it on every ticket.
export function odysse({ repoRoot }: { repoRoot: string }): { prompt: string } {
  const tree = formatFileTree(listProjectFiles(repoRoot));
  const prompt = buildOdysseFullPrompt({
    tree,
    repoRoot,
    categories: loadCategories(repoRoot),
    cli: glafkaCli(repoRoot),
  });
  return { prompt };
}

// Only covers what a ticket touched. `treeRoot` is where we scan,
// and `repoRoot` is where the docs live. They differ after a push.
export function odysseUpdate({
  repoRoot,
  treeRoot = repoRoot,
  changedPaths,
  diff = null,
}: {
  repoRoot: string;
  treeRoot?: string;
  changedPaths: string[];
  diff?: string | null;
}): { prompt: string } {
  const tree = formatFileTree(affectedFiles(listProjectFiles(treeRoot), changedPaths));
  const prompt = buildOdysseUpdatePrompt({ changedPaths, tree, repoRoot, treeRoot, diff });
  return { prompt };
}

// The tree, cut down to the top-level areas this ticket actually touched. It used to be the WHOLE
// project every time — labelled "for context, not to re-scan", which is a sentence asking an agent
// not to do the thing the data in front of it invites. On a real repo that is thousands of lines
// paid for on every push, to answer a question about two directories.
//
// Cut at the TOP level, not at the exact directory: a doc for `src/foo` legitimately names its
// neighbours, and a tree that hid them would make the agent go and look for them itself, which
// costs more than including them. Falls back to the whole tree when nothing matches, because an
// empty tree is worse than a big one.
function affectedFiles(allFiles: string[], changedPaths: string[]): string[] {
  const areas = new Set(changedPaths.map((p) => p.split('/')[0]).filter(Boolean));
  if (areas.size === 0) return allFiles;
  const kept = allFiles.filter((f) => areas.has(f.split('/')[0]!));
  return kept.length > 0 ? kept : allFiles;
}

// A person picks which findings to keep. It is a separate call,
// because it needs a human answer first.
export function odysseDecide({ repoRoot, keep }: { repoRoot: string; keep: string }): {
  kept: EthosProposal[];
  decided: number;
} {
  const proposals = readProposals(repoRoot);
  if (proposals.length === 0) return { kept: [], decided: 0 };
  return decideProposals(repoRoot, parseKeepArg(keep, proposals.length));
}

// What to show after the scan prompt runs. `ranAgent` says whether an agent really ran, or we only printed the prompt for a person.
// Everything here is read back off disk, so glafka owns the whole run report and the agent never has to write one.
export function odysseFollowUp({ repoRoot, ranAgent }: { repoRoot: string; ranAgent: boolean }): {
  ranAgent: boolean;
  proposals: EthosProposal[];
  workspace: string[];
  docsWritten: number;
  isolationWritten: boolean;
} {
  if (!ranAgent) {
    return { ranAgent, proposals: [], workspace: [], docsWritten: 0, isolationWritten: false };
  }
  return {
    ranAgent,
    proposals: readProposals(repoRoot),
    workspace: readWorkspaceProposalListing(repoRoot),
    docsWritten: countArchitectureDocs(repoRoot),
    isolationWritten: fs.existsSync(isolationProfilePath(repoRoot)),
  };
}

export function odysseWorkspaceDecide({ repoRoot, keep }: { repoRoot: string; keep: string }): {
  applied: string[];
  profileWritten: boolean;
  keptChecksCmd: string | null;
  decided: number;
} {
  const labels = readWorkspaceProposalListing(repoRoot);
  if (labels.length === 0) {
    return { applied: [], profileWritten: false, keptChecksCmd: null, decided: 0 };
  }
  return {
    ...applyWorkspaceDecision(repoRoot, parseKeepArg(keep, labels.length)),
    decided: labels.length,
  };
}

// Its own run, not one more part of the big scan. The big scan already does
// four jobs. The agent only finds the command; glafka tests it when a person keeps it.
export function odysseChecks({ repoRoot }: { repoRoot: string }): { prompt: string } {
  return { prompt: buildChecksProbePrompt({ repoRoot }) };
}

export { readWorkspaceProposalListing };
export {
  buildOdysseFullPrompt,
  buildOdysseUpdatePrompt,
  buildChecksProbePrompt,
} from './prompts.js';
