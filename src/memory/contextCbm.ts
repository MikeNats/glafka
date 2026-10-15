import { readArchitectureIndex } from './docsStore.js';
import { cbmAvailable, cbmQuery } from './cbm.js';
import type { CbmOpts } from './cbm.js';

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
