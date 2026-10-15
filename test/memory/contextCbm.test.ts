import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeDoc, architectureIndexPath } from '../../src/memory/docsStore.js';
import { makeTempDir } from '../helpers/tempDir.js';
import type { CbmExec } from '../../src/memory/cbm.js';
import {
  cbmArchitecture,
  cbmFileOutlines,
  cbmBlastRadius,
  loadPromptContextFor,
} from '../../src/memory/context.js';
import { ethosPath } from '../../src/memory/docsStore.js';
import { AUTHORED_HEADING } from '../../src/memory/ethos.js';
import type { CbmOpts } from '../../src/memory/cbm.js';

// --- Helpers ---

function tempDir(): string {
  return makeTempDir('contextCbm');
}

function cbmPresent(result: string): CbmOpts {
  const exec: CbmExec = (_bin, _args) => result;
  return { exec };
}

function cbmAbsent(): CbmOpts {
  const exec: CbmExec = () => {
    const err = new Error('ENOENT') as Error & { code: string };
    err.code = 'ENOENT';
    throw err;
  };
  return { exec };
}

// --- cbmArchitecture ---

test('cbmArchitecture — CBM present → returns get_architecture output', () => {
  const repoRoot = tempDir();
  const opts = cbmPresent('## Architecture\ngraph data');
  const result = cbmArchitecture(repoRoot, opts);
  assert.equal(result, '## Architecture\ngraph data');
});

test('cbmArchitecture — CBM absent, README exists → returns README content', () => {
  const repoRoot = tempDir();
  writeDoc(architectureIndexPath(repoRoot), '# Map from README\n');
  const result = cbmArchitecture(repoRoot, cbmAbsent());
  assert.match(result!, /Map from README/);
});

test('cbmArchitecture — CBM absent, no README → returns null', () => {
  const repoRoot = tempDir();
  const result = cbmArchitecture(repoRoot, cbmAbsent());
  assert.equal(result, null);
});

// --- cbmFileOutlines ---

test('cbmFileOutlines — CBM present, files given → concatenated outlines', () => {
  const repoRoot = tempDir();
  const calls: string[] = [];
  const exec: CbmExec = (_bin, args) => {
    // cbmAvailable calls --help first; skip that
    if (args.includes('--help')) return '';
    const pathArg = args[args.indexOf('--path') + 1]!;
    calls.push(pathArg);
    return `outline of ${pathArg}\n`;
  };
  const result = cbmFileOutlines(repoRoot, ['src/a.ts', 'src/b.ts'], { exec });
  assert.equal(result, 'outline of src/a.ts\noutline of src/b.ts');
  assert.deepEqual(calls, ['src/a.ts', 'src/b.ts']);
});

test('cbmFileOutlines — CBM present, empty files → falls back to get_architecture', () => {
  const repoRoot = tempDir();
  const opts = cbmPresent('architecture fallback');
  const result = cbmFileOutlines(repoRoot, [], opts);
  assert.equal(result, 'architecture fallback');
});

test('cbmFileOutlines — CBM absent, README exists → returns README', () => {
  const repoRoot = tempDir();
  writeDoc(architectureIndexPath(repoRoot), '# Fallback map\n');
  const result = cbmFileOutlines(repoRoot, ['src/a.ts'], cbmAbsent());
  assert.match(result!, /Fallback map/);
});

// --- cbmBlastRadius ---

test('cbmBlastRadius — CBM present, paths given → returns detect_changes output', () => {
  const repoRoot = tempDir();
  const calls: Record<string, string>[] = [];
  const exec: CbmExec = (_bin, args) => {
    if (args.includes('--help')) return '';
    const pathsIdx = args.indexOf('--paths');
    calls.push({ paths: args[pathsIdx + 1]! });
    return 'blast radius summary\n';
  };
  const result = cbmBlastRadius(repoRoot, ['src/a.ts', 'src/b.ts'], { exec });
  assert.equal(result, 'blast radius summary');
  assert.equal(calls[0]!.paths, 'src/a.ts,src/b.ts');
});

test('cbmBlastRadius — CBM present, empty paths → falls back to get_architecture', () => {
  const repoRoot = tempDir();
  const opts = cbmPresent('architecture fallback');
  const result = cbmBlastRadius(repoRoot, [], opts);
  assert.equal(result, 'architecture fallback');
});

test('cbmBlastRadius — CBM absent, README exists → returns README', () => {
  const repoRoot = tempDir();
  writeDoc(architectureIndexPath(repoRoot), '# Blast fallback\n');
  const result = cbmBlastRadius(repoRoot, ['src/a.ts'], cbmAbsent());
  assert.match(result!, /Blast fallback/);
});

// --- loadPromptContextFor ---

function repoWithEthos(): string {
  const repoRoot = tempDir();
  writeDoc(
    ethosPath(repoRoot, 'ETHOS_CODE'),
    `# ETHOS_CODE\n\n${AUTHORED_HEADING}\n\n- no wrappers\n`,
  );
  return repoRoot;
}

test('loadPromptContextFor — spec consumer, CBM present', () => {
  const repoRoot = repoWithEthos();
  const ctx = loadPromptContextFor({
    consumer: 'spec',
    repoRoot,
    cbmOpts: cbmPresent('arch from cbm'),
  });
  assert.equal(ctx.architectureIndex, 'arch from cbm');
  assert.equal(ctx.architectureFreshness, null);
  assert.match(ctx.ethosContent!, /no wrappers/);
});

test('loadPromptContextFor — plan consumer, CBM present', () => {
  const repoRoot = repoWithEthos();
  const ctx = loadPromptContextFor({
    consumer: 'plan',
    repoRoot,
    cbmOpts: cbmPresent('plan arch data'),
  });
  assert.equal(ctx.architectureIndex, 'plan arch data');
  assert.equal(ctx.architectureFreshness, null);
});

test('loadPromptContextFor — coder consumer with files', () => {
  const repoRoot = tempDir();
  const exec: CbmExec = (_bin, args) => {
    if (args.includes('--help')) return '';
    return 'file outline data\n';
  };
  const ctx = loadPromptContextFor({
    consumer: 'coder',
    repoRoot,
    files: ['src/a.ts'],
    cbmOpts: { exec },
  });
  assert.equal(ctx.architectureIndex, 'file outline data');
});

test('loadPromptContextFor — reviewer consumer with changed paths', () => {
  const repoRoot = tempDir();
  const exec: CbmExec = (_bin, args) => {
    if (args.includes('--help')) return '';
    return 'blast radius data\n';
  };
  const ctx = loadPromptContextFor({
    consumer: 'reviewer',
    repoRoot,
    paths: ['src/a.ts'],
    cbmOpts: { exec },
  });
  assert.equal(ctx.architectureIndex, 'blast radius data');
});

test('loadPromptContextFor — CBM absent fallback uses README', () => {
  const repoRoot = tempDir();
  writeDoc(architectureIndexPath(repoRoot), '# README map\n');
  const ctx = loadPromptContextFor({
    consumer: 'spec',
    repoRoot,
    cbmOpts: cbmAbsent(),
  });
  assert.match(ctx.architectureIndex!, /README map/);
  // Freshness is set when using the fallback
  assert.notEqual(ctx.architectureFreshness, null);
});
