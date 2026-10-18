import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Runnable } from './tool';

export const UNREADABLE = 'could not read this file';

type Lister = (file: string, json: unknown) => Runnable[];

// What some JSON files of a project can make run. Missing: none. Not JSON: one item holding its
// raw text, so a broken file still asks (whoever reads it may read it another way).
export function readTrustItems(
  project: string,
  files: readonly string[],
  list: Lister,
): Runnable[] {
  return files.flatMap((file) => {
    const full = path.join(project, file);
    if (!existsSync(full)) return [];
    let raw = '';
    try {
      raw = readFileSync(full, 'utf8');
      return list(file, JSON.parse(raw));
    } catch {
      return [{ file, what: UNREADABLE, run: raw }];
    }
  });
}
