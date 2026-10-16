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

interface ArchResult {
  value: string | null;
  fromCbm: boolean;
}

function resolveArchitecture(
  consumer: Consumer,
  repoRoot: string,
  hasCbm: boolean,
  opts: { paths?: string[] | null; files?: string[] | null; cbmOpts?: CbmOpts },
): ArchResult {
  if (!hasCbm) return { value: readArchitectureIndex(repoRoot), fromCbm: false };
  switch (consumer) {
    case 'spec':
    case 'plan':
      return { value: cbmQuery(repoRoot, 'get_architecture', {}, opts.cbmOpts), fromCbm: true };
    case 'coder':
      if (opts.files && opts.files.length > 0) {
        const outlines = opts.files
          .map((f) => cbmQuery(repoRoot, 'get_file_outline', { path: f }, opts.cbmOpts))
          .join('\n');
        return { value: outlines, fromCbm: true };
      }
      return { value: cbmQuery(repoRoot, 'get_architecture', {}, opts.cbmOpts), fromCbm: true };
    case 'reviewer':
      if (opts.paths && opts.paths.length > 0) {
        return {
          value: cbmQuery(
            repoRoot,
            'detect_changes',
            { paths: opts.paths.join(',') },
            opts.cbmOpts,
          ),
          fromCbm: true,
        };
      }
      return { value: cbmQuery(repoRoot, 'get_architecture', {}, opts.cbmOpts), fromCbm: true };
  }
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
  const { value: arch, fromCbm } = resolveArchitecture(consumer, repoRoot, cbmAvailable(cbmOpts), {
    paths,
    files,
    cbmOpts,
  });
  return {
    architectureIndex: arch,
    architectureFreshness: fromCbm ? null : architectureFreshness(repoRoot),
    ethosContent: readEthosDocs(repoRoot, paths),
    proorismos: readProorismos(repoRoot),
    categories: loadCategories(repoRoot),
  };
}
