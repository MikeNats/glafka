import { readArchitectureIndex, readProorismos } from './docsStore.js';
import { readEthosDocs } from './ethos.js';
import { loadCategories } from './categories.js';
import { cbmAvailable, cbmQuery } from './cbm.js';
import type { CbmOpts } from './cbm.js';
import { architectureFreshness } from './context.js';
import type { PromptContext } from '../types/promptContext.js';

export type Consumer = 'spec' | 'plan' | 'coder' | 'reviewer';

export function cbmArchitecture(repoRoot: string, opts?: CbmOpts): string | null {
  if (cbmAvailable(opts)) {
    return cbmQuery(repoRoot, 'get_architecture', {}, opts);
  }
  return readArchitectureIndex(repoRoot);
}

export function cbmFileOutlines(
  repoRoot: string,
  files: string[] | null,
  opts?: CbmOpts,
): string | null {
  if (!files || files.length === 0) return cbmArchitecture(repoRoot, opts);
  if (!cbmAvailable(opts)) return readArchitectureIndex(repoRoot);
  return files.map((f) => cbmQuery(repoRoot, 'get_file_outline', { path: f }, opts)).join('\n');
}

export function cbmBlastRadius(
  repoRoot: string,
  paths: string[] | null,
  opts?: CbmOpts,
): string | null {
  if (!paths || paths.length === 0) return cbmArchitecture(repoRoot, opts);
  if (!cbmAvailable(opts)) return readArchitectureIndex(repoRoot);
  return cbmQuery(repoRoot, 'detect_changes', { paths: paths.join(',') }, opts);
}

export function loadPromptContextFor({
  consumer,
  repoRoot,
  worktree = repoRoot,
  paths = null,
  files = null,
  cbmOpts,
}: {
  consumer: Consumer;
  repoRoot: string;
  worktree?: string | null;
  paths?: string[] | null;
  files?: string[] | null;
  cbmOpts?: CbmOpts;
}): PromptContext {
  void worktree;

  let arch: string | null;
  switch (consumer) {
    case 'spec':
    case 'plan':
      arch = cbmArchitecture(repoRoot, cbmOpts);
      break;
    case 'coder':
      arch = cbmFileOutlines(repoRoot, files, cbmOpts);
      break;
    case 'reviewer':
      arch = cbmBlastRadius(repoRoot, paths, cbmOpts);
      break;
  }

  const usedCbm = cbmAvailable(cbmOpts) && arch !== readArchitectureIndex(repoRoot);
  const freshness = usedCbm ? null : architectureFreshness(repoRoot);

  return {
    architectureIndex: arch,
    architectureFreshness: freshness,
    ethosContent: readEthosDocs(repoRoot, paths),
    proorismos: readProorismos(repoRoot),
    categories: loadCategories(repoRoot),
  };
}
