import { readArchitectureIndex, readProorismos } from './docsStore.js';
import { readEthosDocs } from './ethos.js';
import { loadCategories } from './categories.js';
import { cbmAvailable, cbmQuery, cbmProject, CbmError } from './cbm.js';
import type { CbmOpts } from './cbm.js';
import { architectureFreshness } from './context.js';
import type { PromptContext } from '../types/promptContext.js';

export type Consumer = 'spec' | 'plan' | 'coder' | 'reviewer';

// Each outline is about 2 KB of prompt. Past this many files, the overview says more per byte.
const MAX_OUTLINES = 8;

interface ArchResult {
  value: string | null;
  fromCbm: boolean;
}

interface GraphAsk {
  paths: string[] | null;
  files: string[] | null;
  baseRef: string | null;
  cbmOpts?: CbmOpts;
}

// Packages, entry points, hotspots, boundaries and layers: what a planner needs to place a
// change. Asked by name: the default view opens with node counts that help no one.
const OVERVIEW_ASPECTS = '["packages","entry_points","hotspots","boundaries","layers"]';

function overview(root: string, cbmOpts?: CbmOpts): string {
  return cbmQuery(root, 'get_architecture', { aspects: OVERVIEW_ASPECTS }, cbmOpts);
}

// A file the plan names may not exist yet. It is skipped, not a reason to lose every outline.
function outlines(root: string, files: string[], cbmOpts?: CbmOpts): string {
  const found: string[] = [];
  for (const file of files.slice(0, MAX_OUTLINES)) {
    try {
      found.push(cbmQuery(root, 'get_file_outline', { 'file-path': file }, cbmOpts));
    } catch (err) {
      if (!(err instanceof CbmError)) throw err;
    }
  }
  return found.join('\n\n');
}

// The one question each consumer asks. `root` is the checkout whose code it reads.
function askGraph(consumer: Consumer, root: string, ask: GraphAsk): string {
  if (consumer === 'coder' && ask.files && ask.files.length > 0) {
    return outlines(root, ask.files, ask.cbmOpts) || overview(root, ask.cbmOpts);
  }
  // What the change touches, and who calls it: the blast radius a text map cannot give.
  if (consumer === 'reviewer' && ask.paths && ask.paths.length > 0) {
    const flags: Record<string, string> = { scope: 'impact' };
    if (ask.baseRef) flags['base-branch'] = ask.baseRef;
    return cbmQuery(root, 'detect_changes', flags, ask.cbmOpts);
  }
  return overview(root, ask.cbmOpts);
}

function resolveArchitecture(
  consumer: Consumer,
  repoRoot: string,
  root: string,
  ask: GraphAsk,
): ArchResult {
  if (cbmAvailable(ask.cbmOpts)) {
    try {
      const value = askGraph(consumer, root, ask);
      if (value.trim()) return { value, fromCbm: true };
    } catch (err) {
      if (!(err instanceof CbmError)) throw err;
    }
  }
  // No graph, or it failed or said nothing. An empty map would leave the agent with none at all.
  return { value: readArchitectureIndex(repoRoot), fromCbm: false };
}

export function loadPromptContextFor({
  consumer,
  repoRoot,
  worktree = repoRoot,
  paths = null,
  files = null,
  baseRef = null,
  cbmOpts,
}: {
  consumer: Consumer;
  repoRoot: string;
  worktree?: string | null;
  paths?: string[] | null;
  files?: string[] | null;
  // The branch the reviewer compares against. Null lets the tool pick main.
  baseRef?: string | null;
  cbmOpts?: CbmOpts;
}): PromptContext {
  // The ticket's own code, not main's: that is what the coder changes and the reviewer reads.
  const root = worktree ?? repoRoot;
  const { value: arch, fromCbm } = resolveArchitecture(consumer, repoRoot, root, {
    paths,
    files,
    baseRef,
    cbmOpts,
  });
  return {
    architectureIndex: arch,
    architectureFreshness: fromCbm ? null : architectureFreshness(repoRoot),
    // The same checkout the graph just indexed, so its live tools answer about this code.
    codeGraph: fromCbm ? cbmProject(root) : null,
    ethosContent: readEthosDocs(repoRoot, paths),
    proorismos: readProorismos(repoRoot),
    categories: loadCategories(repoRoot),
  };
}
