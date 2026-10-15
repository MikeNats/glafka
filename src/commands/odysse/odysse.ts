import { formatFileTree } from '../../util/fileOperations.js';
import { glafkaCli } from '../../util/cli.js';
import { listProjectFiles } from '../../util/git.js';
import { loadCategories } from '../../memory/categories.js';
import { readWorkspaceProposalListing } from './utils.js';
import {
  buildOdysseFullPrompt,
  buildOdysseUpdatePrompt,
  buildChecksProbePrompt,
} from './prompts.js';
import { cbmAvailable, cbmIndexRepository } from '../../memory/cbm.js';

export type OdysseResult =
  { prompt: null; cbmIndexed: true } | { prompt: string; cbmIndexed: false };

interface CbmFns {
  available: () => boolean;
  indexRepository: (repoRoot: string) => void;
}

// The whole-repo prompt. Run it once, or to refresh.
// Prefers codebase-memory-mcp when present; falls back to the LLM prompt.
export function odysse({ repoRoot, cbm }: { repoRoot: string; cbm?: CbmFns }): OdysseResult {
  const fns: CbmFns = cbm ?? { available: cbmAvailable, indexRepository: cbmIndexRepository };
  if (fns.available()) {
    fns.indexRepository(repoRoot);
    return { prompt: null, cbmIndexed: true };
  }
  const tree = formatFileTree(listProjectFiles(repoRoot));
  const prompt = buildOdysseFullPrompt({
    tree,
    repoRoot,
    categories: loadCategories(repoRoot),
    cli: glafkaCli(repoRoot),
  });
  return { prompt, cbmIndexed: false };
}

// Only covers what a ticket touched.
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

// Cut at the TOP level: a doc for `src/foo` legitimately names its neighbours.
function affectedFiles(allFiles: string[], changedPaths: string[]): string[] {
  const areas = new Set(changedPaths.map((p) => p.split('/')[0]).filter(Boolean));
  if (areas.size === 0) return allFiles;
  const kept = allFiles.filter((f) => areas.has(f.split('/')[0]!));
  return kept.length > 0 ? kept : allFiles;
}

// Its own run, not one more part of the big scan.
export function odysseChecks({ repoRoot }: { repoRoot: string }): { prompt: string } {
  return { prompt: buildChecksProbePrompt({ repoRoot }) };
}

export { readWorkspaceProposalListing };
export { odysseDecide, odysseFollowUp, odysseWorkspaceDecide } from './followUp.js';
export {
  buildOdysseFullPrompt,
  buildOdysseUpdatePrompt,
  buildChecksProbePrompt,
} from './prompts.js';
