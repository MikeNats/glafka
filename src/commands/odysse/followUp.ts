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

// What to show after the scan prompt runs.
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
