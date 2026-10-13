import fs from 'node:fs';
import path from 'node:path';
import { readDoc } from './docsStore.js';
import type { Category } from '../types/promptContext.js';

// A category is a box for rules, like SECURITY.

const CATEGORIES_FILE = 'categories.json';
// Used when a project has no categories file of its own.
export const DEFAULT_CATEGORIES: readonly Category[] = Object.freeze([
  {
    name: 'CODE',
    hint: 'naming, imports, error handling, language-level idiom',
  },
  {
    name: 'DESIGN',
    hint: 'which abstractions to reach for or refuse, API shape',
  },
  {
    name: 'ARCHITECTURE',
    hint: 'layer boundaries, data-flow direction, where state lives',
  },
  {
    name: 'TESTING',
    hint: 'what must be covered, fixture/mock discipline, which gates are hard',
  },
  {
    name: 'SECURITY',
    hint: 'authn/authz, secrets, what may be logged, tenant isolation',
  },
  { name: 'PERFORMANCE', hint: 'query shape, N+1, caching, batching, budgets' },
  {
    name: 'AI',
    hint: 'model choice, prompt and tool conventions, token limits, evals',
  },
  {
    name: 'WORKSPACE',
    hint: 'what a fresh worktree needs to actually run: base branch, submodules, dependency install, local-only files, anything a generic checkout would get wrong',
  },
  {
    name: 'TECHNOLOGIES',
    hint: 'libraries and frameworks to reach for or avoid, version constraints, build-vs-buy calls',
  },
  {
    name: 'INFRASTRUCTURE',
    hint: 'cloud provider conventions (AWS/GCP/Azure), containers, orchestration, CI/CD, deployment',
  },
]);

export function categoriesPath(repoRoot: string): string {
  return path.join(repoRoot, 'docs/glafka/ethos', CATEGORIES_FILE);
}

// The ETHOS_ start makes the file easy to spot.
export function targetOf(category: Category): string {
  return `ETHOS_${category.name}`;
}

export function flagOf(category: Category): string {
  return `--${category.name.toLowerCase()}`;
}

export function targetsOf(categories: readonly Category[]): string[] {
  return categories.map(targetOf);
}

// Links each command flag to its file name.
export function flagsOf(categories: readonly Category[]): Readonly<Record<string, string>> {
  return Object.freeze(
    Object.fromEntries(categories.map((category) => [flagOf(category), targetOf(category)])),
  );
}

export function categoryByTarget(categories: readonly Category[], target: string): Category | null {
  return categories.find((category) => targetOf(category) === target) ?? null;
}

// Names may hold only capital letters and underscores.
const NAME_RE = /^[A-Z][A-Z0-9_]*$/;

function validate(categories: unknown, filePath: string): Category[] {
  if (!Array.isArray(categories)) {
    throw new Error(
      `${filePath}: must be a JSON array of { name, hint }, got ${typeof categories}`,
    );
  }
  if (categories.length === 0) {
    throw new Error(
      `${filePath}: is an empty array — delete the file to fall back to glafka's defaults, ` +
        `or list the categories you want`,
    );
  }

  const seen = new Set<string>();
  for (const category of categories) {
    if (!category || typeof category !== 'object' || Array.isArray(category)) {
      throw new Error(
        `${filePath}: every entry must be an object, got ${JSON.stringify(category)}`,
      );
    }
    const { name, hint } = category as { name: unknown; hint: unknown };
    if (typeof name !== 'string' || !NAME_RE.test(name)) {
      throw new Error(
        `${filePath}: "name" must be UPPERCASE letters, digits and underscores, starting with a ` +
          `letter (e.g. "SECURITY", "DATA_MODEL") — got ${JSON.stringify(name)}`,
      );
    }
    if (typeof hint !== 'string' || hint.trim() === '') {
      throw new Error(
        `${filePath}: category "${name}" needs a non-empty "hint" — it's the only thing that ` +
          `tells an agent what belongs in this bucket`,
      );
    }
    if (seen.has(name)) {
      throw new Error(
        `${filePath}: category "${name}" is listed twice — names map to filenames, so duplicates ` +
          `would fight over the same file`,
      );
    }
    seen.add(name);
  }

  return Object.freeze(
    categories.map((category: { name: string; hint: string }) =>
      Object.freeze({ name: category.name, hint: category.hint.trim() }),
    ),
  ) as Category[];
}

// A project file REPLACES the defaults. It does not add to them.
export function loadCategories(repoRoot: string): readonly Category[] {
  const filePath = categoriesPath(repoRoot);
  if (!fs.existsSync(filePath)) return DEFAULT_CATEGORIES;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readDoc(filePath));
  } catch (err) {
    throw new Error(`${filePath}: not valid JSON — ${(err as Error).message}`);
  }
  return validate(parsed, filePath);
}
