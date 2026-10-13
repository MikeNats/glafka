import fs from 'node:fs';
import path from 'node:path';
import { DOCS_ROOT, readDoc } from './docsStore.js';

// The engineering standards a review is held to. Read the same way ethos is — walk a fixed list,
// join the parts — so there is one mental model for "project text that goes into a prompt", not two.
//
// These go to the REVIEWER ONLY, and that is the whole point of them being a separate folder from
// ethos. Ethos is injected into every coder prompt as well, so it has to stay short or it turns
// into wallpaper; a lane with three tables in it would do exactly that. The reviewer runs once, at
// the end, and can afford to read the long version.

export const STANDARDS_DIR = `${DOCS_ROOT}/standards`;

// Fixed order, worst-first, matching the verdict lines each lane ends with. A directory listing
// would order these by filename, which is not the order a reviewer should read them in.
export const STANDARDS_FILES = Object.freeze([
  'how-to-review.md',
  'security.md',
  'correctness.md',
  'testing.md',
  'performance.md',
  'design.md',
]);

export function standardsDir(repoRoot: string): string {
  return path.join(repoRoot, STANDARDS_DIR);
}

export function standardsInstalled(repoRoot: string): boolean {
  return STANDARDS_FILES.some((name) => fs.existsSync(path.join(standardsDir(repoRoot), name)));
}

// Every lane this project has, joined. A file that was deleted is simply skipped: removing a lane
// is a real way to say "this does not apply here", and it must not break the review.
//
// Files NOT on the list are ignored rather than appended. Someone's notes left in the folder would
// otherwise become binding review input by being in the right directory, which is the same
// accident `reviewDoc` exists to prevent.
export function readStandards(repoRoot: string): string | null {
  const dir = standardsDir(repoRoot);
  const parts: string[] = [];
  for (const name of STANDARDS_FILES) {
    const filePath = path.join(dir, name);
    if (!fs.existsSync(filePath)) continue;
    const body = readDoc(filePath).trim();
    if (body !== '') parts.push(body);
  }
  return parts.length > 0 ? parts.join('\n\n') : null;
}

// The project's own review document, named in .glafka.json. Missing file is not an error here — a
// path that stops resolving must not make every review fail; the reviewer just gets one source
// fewer, and `poreia`-style commands stay usable.
export function readReviewDoc(repoRoot: string, reviewDoc: string | null): string | null {
  if (!reviewDoc) return null;
  const filePath = path.isAbsolute(reviewDoc) ? reviewDoc : path.join(repoRoot, reviewDoc);
  if (!fs.existsSync(filePath)) return null;
  const body = readDoc(filePath).trim();
  return body === '' ? null : body;
}
