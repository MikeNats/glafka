import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDir } from '../helpers/tempDir.js';
import {
  ethosPath,
  architectureIndexPath,
  isolationProfilePath,
  proorismosPath,
  writeDoc,
  readDoc,
  readArchitectureIndex,
  readIsolationProfile,
  readProorismos,
  workspaceProposalPath,
  workspaceAtoms,
  applyWorkspaceDecision,
} from '../../src/memory/docsStore.js';
import { DEFAULT_CATEGORIES, targetOf } from '../../src/memory/categories.js';

// The default categories, in the old shape, so these tests still read
// the same even though categories.json is now the real source.
const T = Object.fromEntries(DEFAULT_CATEGORIES.map((c) => [c.name, targetOf(c)]));

// Small helper used by every workspace test below.
function writeProfile(repoRoot: string, profile: unknown) {
  writeDoc(isolationProfilePath(repoRoot), JSON.stringify(profile));
}

function tempRepoRoot() {
  return makeTempDir('docs');
}

// specPath/planPath moved to ticket/paths.js, so ticket ids are checked
// in one place. See test/ticket/paths.test.js.

test('ethosPath is one file per target, not per ticket', () => {
  const repoRoot = tempRepoRoot();

  assert.equal(
    ethosPath(repoRoot, 'ETHOS_CODE'),
    path.join(repoRoot, 'docs/glafka/ethos/ETHOS_CODE.md'),
  );
  assert.equal(
    ethosPath(repoRoot, 'ETHOS_DESIGN'),
    path.join(repoRoot, 'docs/glafka/ethos/ETHOS_DESIGN.md'),
  );
  assert.equal(
    ethosPath(repoRoot, 'ETHOS_ARCHITECTURE'),
    path.join(repoRoot, 'docs/glafka/ethos/ETHOS_ARCHITECTURE.md'),
  );
});

// Checks every target's file path, even ones added later. A target
// not under docs/glafka/ethos/ would be invisible to readEthosDocs.
test('every ETHOS_TARGETS value resolves under docs/glafka/ethos/', () => {
  const repoRoot = tempRepoRoot();

  for (const target of Object.values(T)) {
    assert.equal(
      ethosPath(repoRoot, target),
      path.join(repoRoot, 'docs/glafka/ethos', `${target}.md`),
    );
  }
});

// Rules live under ethos/. The map odysse builds lives under architecture/.
// Same topic, different files — they must never share a path.
test("ETHOS_ARCHITECTURE does not collide with odysse's architecture map", () => {
  const repoRoot = tempRepoRoot();

  assert.notEqual(
    path.dirname(ethosPath(repoRoot, 'ETHOS_ARCHITECTURE')),
    path.join(repoRoot, 'docs/glafka/architecture'),
  );
});

test('writeDoc then readDoc round-trips content, creating parent dirs', () => {
  const repoRoot = tempRepoRoot();
  // This path does not exist yet. The test checks writeDoc creates
  // the folders on the way, not which file it is.
  const filePath = path.join(repoRoot, 'docs/glafka/specs/anything.md');

  writeDoc(filePath, '# Spec\n\nDo the thing.\n');

  assert.equal(readDoc(filePath), '# Spec\n\nDo the thing.\n');
});

test('architectureIndexPath points at the top-level README, not the whole tree', () => {
  const repoRoot = tempRepoRoot();

  assert.equal(
    architectureIndexPath(repoRoot),
    path.join(repoRoot, 'docs/glafka/architecture/README.md'),
  );
});

test('readArchitectureIndex returns null when odysse has never been run', () => {
  const repoRoot = tempRepoRoot();

  assert.equal(readArchitectureIndex(repoRoot), null);
});

test('readArchitectureIndex returns the index content once it exists', () => {
  const repoRoot = tempRepoRoot();
  writeDoc(architectureIndexPath(repoRoot), '# Architecture\n\n- src/ — the CLI\n');

  assert.equal(readArchitectureIndex(repoRoot), '# Architecture\n\n- src/ — the CLI\n');
});

test('isolationProfilePath lives alongside the architecture docs', () => {
  const repoRoot = tempRepoRoot();

  assert.equal(
    isolationProfilePath(repoRoot),
    path.join(repoRoot, 'docs/glafka/architecture/isolation.json'),
  );
});

test('readIsolationProfile returns null when odysse never discovered one', () => {
  const repoRoot = tempRepoRoot();

  assert.equal(readIsolationProfile(repoRoot), null);
});

test('readIsolationProfile parses the profile once odysse has written one', () => {
  const repoRoot = tempRepoRoot();
  const profile = { services: [{ name: 'db', envVars: ['DB_PORT'] }] };
  writeDoc(isolationProfilePath(repoRoot), JSON.stringify(profile));

  assert.deepEqual(readIsolationProfile(repoRoot), profile);
});

test('readIsolationProfile rejects a service with no name', () => {
  const repoRoot = tempRepoRoot();
  writeDoc(
    isolationProfilePath(repoRoot),
    JSON.stringify({ services: [{ envVars: ['DB_PORT'] }] }),
  );

  assert.throws(() => readIsolationProfile(repoRoot), /non-empty string "name"/);
});

test('readIsolationProfile rejects a service with no envVars', () => {
  const repoRoot = tempRepoRoot();
  writeDoc(isolationProfilePath(repoRoot), JSON.stringify({ services: [{ name: 'db' }] }));

  assert.throws(
    () => readIsolationProfile(repoRoot),
    /non-empty array of non-empty string "envVars"/,
  );
});

test("readIsolationProfile rejects services that isn't an array", () => {
  const repoRoot = tempRepoRoot();
  writeDoc(isolationProfilePath(repoRoot), JSON.stringify({ services: 'db' }));

  assert.throws(() => readIsolationProfile(repoRoot), /"services" must be an array/);
});

test('readIsolationProfile rejects a non-string setupCmd/teardownCmd', () => {
  const repoRoot = tempRepoRoot();
  writeDoc(
    isolationProfilePath(repoRoot),
    JSON.stringify({ services: [{ name: 'db', envVars: ['DB_PORT'] }], setupCmd: 123 }),
  );

  assert.throws(() => readIsolationProfile(repoRoot), /"setupCmd" must be a string/);
});

test('readIsolationProfile validates e2e.services the same way as the top-level services', () => {
  const repoRoot = tempRepoRoot();
  writeDoc(
    isolationProfilePath(repoRoot),
    JSON.stringify({
      services: [{ name: 'db', envVars: ['DB_PORT'] }],
      e2e: { services: [{ name: 'e2e-db' }] },
    }),
  );

  assert.throws(
    () => readIsolationProfile(repoRoot),
    /non-empty array of non-empty string "envVars"/,
  );
});

test('readIsolationProfile accepts a profile with no setupCmd/teardownCmd/e2e at all', () => {
  const repoRoot = tempRepoRoot();
  const profile = { services: [{ name: 'db', envVars: ['DB_PORT'] }] };
  writeDoc(isolationProfilePath(repoRoot), JSON.stringify(profile));

  assert.doesNotThrow(() => readIsolationProfile(repoRoot));
});

test('proorismosPath lives at the top of docs/glafka, not nested', () => {
  const repoRoot = tempRepoRoot();

  assert.equal(proorismosPath(repoRoot), path.join(repoRoot, 'docs/glafka/proorismos.md'));
});

test('readProorismos returns null when no one has written one yet', () => {
  const repoRoot = tempRepoRoot();

  assert.equal(readProorismos(repoRoot), null);
});

test('readProorismos returns the content once someone has written one', () => {
  const repoRoot = tempRepoRoot();
  writeDoc(proorismosPath(repoRoot), 'Become the default tool for X.\n');

  assert.equal(readProorismos(repoRoot), 'Become the default tool for X.\n');
});

test('readIsolationProfile accepts a workspace block and preserves it', () => {
  const repoRoot = tempRepoRoot();
  writeProfile(repoRoot, {
    services: [{ name: 'db', envVars: ['DB_PORT'] }],
    workspace: {
      baseRef: 'master',
      submodules: { paths: ['packages/client'], branchPerTicket: true },
      bootstrapCmd: 'pnpm install --frozen-lockfile',
      seedFiles: ['.env'],
    },
  });

  const profile = readIsolationProfile(repoRoot);

  assert.equal(profile!.workspace!.baseRef, 'master');
  assert.deepEqual(profile!.workspace!.submodules!.paths, ['packages/client']);
  assert.equal(profile!.workspace!.bootstrapCmd, 'pnpm install --frozen-lockfile');
});

test("readIsolationProfile rejects a workspace whose seedFiles aren't strings", () => {
  const repoRoot = tempRepoRoot();
  writeProfile(repoRoot, { workspace: { seedFiles: [{ path: '.env' }] } });

  assert.throws(() => readIsolationProfile(repoRoot), /workspace\.seedFiles/);
});

test('a profile with no workspace block still loads — the field is optional', () => {
  const repoRoot = tempRepoRoot();
  writeProfile(repoRoot, { services: [{ name: 'db', envVars: ['DB_PORT'] }] });

  assert.equal(readIsolationProfile(repoRoot)!.workspace, undefined);
});

test('workspaceAtoms turns a proposal into one decision per line', () => {
  const atoms = workspaceAtoms({
    baseRef: 'master',
    submodules: { paths: ['packages/client', 'packages/server'], branchPerTicket: true },
    bootstrapCmd: 'pnpm install',
    seedFiles: ['.env', 'packages/server/.env'],
  });

  // Counts: 1 baseRef, 2 submodules, 1 branchPerTicket, 1 bootstrap, 2 seedFiles.
  assert.equal(atoms.length, 7);
  assert.match(atoms[0].label, /base branch: master/);
});

// e2e tests are slow and need services running. Saying yes to unit checks
// must not also say yes to running the full browser suite every time.
test('workspaceAtoms offers the discovered checks and e2e commands as separate decisions', () => {
  const atoms = workspaceAtoms({
    checksCmd: 'uv run pytest && uv run mypy .',
    e2eCmd: 'playwright test',
  });

  assert.equal(atoms.length, 2);
  assert.match(atoms[0].label, /run checks with: uv run pytest && uv run mypy \./);
  assert.match(atoms[1].label, /run e2e with: playwright test/);
});

test("a kept checks atom lands in isolation.json's workspace block", () => {
  const repoRoot = tempRepoRoot();
  writeDoc(
    workspaceProposalPath(repoRoot),
    JSON.stringify({ checksCmd: 'cargo clippy && cargo test', e2eCmd: 'cargo test --test e2e' }),
  );

  // Keep the checks command. Reject the e2e one.
  const { applied } = applyWorkspaceDecision(repoRoot, [1]);

  assert.equal(applied.length, 1);
  const profile = readIsolationProfile(repoRoot);
  assert.equal(profile!.workspace!.checksCmd, 'cargo clippy && cargo test');
  assert.equal(profile!.workspace!.e2eCmd, undefined);
});

test('applyWorkspaceDecision writes only the kept atoms and clears the proposal', () => {
  const repoRoot = tempRepoRoot();
  writeDoc(
    workspaceProposalPath(repoRoot),
    JSON.stringify({
      baseRef: 'master',
      bootstrapCmd: 'pnpm install',
      seedFiles: ['.env'],
    }),
  );

  // Keep the base branch and the bootstrap. Reject copying .env.
  const { applied } = applyWorkspaceDecision(repoRoot, [1, 2]);

  assert.equal(applied.length, 2);
  const profile = readIsolationProfile(repoRoot);
  assert.equal(profile!.workspace!.baseRef, 'master');
  assert.equal(profile!.workspace!.bootstrapCmd, 'pnpm install');
  assert.equal(profile!.workspace!.seedFiles, undefined, 'a rejected atom must not be written');
  assert.equal(fs.existsSync(workspaceProposalPath(repoRoot)), false, 'proposal is consumed once');
});

test('applyWorkspaceDecision merges into an existing profile instead of replacing it', () => {
  const repoRoot = tempRepoRoot();
  writeProfile(repoRoot, { services: [{ name: 'db', envVars: ['DB_PORT'] }], setupCmd: 'echo up' });
  writeDoc(workspaceProposalPath(repoRoot), JSON.stringify({ baseRef: 'master' }));

  applyWorkspaceDecision(repoRoot, [1]);

  const profile = readIsolationProfile(repoRoot);
  assert.equal(profile!.setupCmd, 'echo up', 'existing keys survive');
  assert.deepEqual(profile!.services, [{ name: 'db', envVars: ['DB_PORT'] }]);
  assert.equal(profile!.workspace!.baseRef, 'master');
});
