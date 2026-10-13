import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { prosopon } from '../../src/commands/prosopon/prosopon.js';
import { makeTempDir } from '../helpers/tempDir.js';

function tempDirs() {
  const stateDir = makeTempDir('state');
  const personasDir = makeTempDir('personas');
  fs.writeFileSync(path.join(personasDir, 'teacher.md'), '# Teacher\n');
  fs.writeFileSync(path.join(personasDir, 'greek.md'), '# Greek\n');
  return { stateDir, personasDir };
}

test('prosopon with no name reports status without changing anything', () => {
  const { stateDir, personasDir } = tempDirs();

  const result = prosopon({ stateDir, personasDir });

  assert.deepEqual(result.active, []);
  assert.deepEqual(result.available, ['greek', 'teacher']);
});

test('prosopon with a name turns that persona on', () => {
  const { stateDir, personasDir } = tempDirs();

  const result = prosopon({ stateDir, personasDir, name: 'teacher' });

  assert.deepEqual(result.active, ['teacher']);
  assert.deepEqual(prosopon({ stateDir, personasDir }).active, ['teacher']);
});

test('prosopon with the same name again turns it back off', () => {
  const { stateDir, personasDir } = tempDirs();

  prosopon({ stateDir, personasDir, name: 'teacher' });
  const result = prosopon({ stateDir, personasDir, name: 'teacher' });

  assert.deepEqual(result.active, []);
});

// Each persona carries its own reply template now, so two in one prompt compete.
test('prosopon holds one persona at a time — a second pick replaces the first', () => {
  const { stateDir, personasDir } = tempDirs();

  prosopon({ stateDir, personasDir, name: 'teacher' });
  const result = prosopon({ stateDir, personasDir, name: 'greek' });

  assert.deepEqual(result.active, ['greek']);
});

test('prosopon with clear empties the whole active set', () => {
  const { stateDir, personasDir } = tempDirs();

  prosopon({ stateDir, personasDir, name: 'teacher' });
  prosopon({ stateDir, personasDir, name: 'greek' });
  const result = prosopon({ stateDir, personasDir, clear: true });

  assert.deepEqual(result.active, []);
});

// ---------------------------------------------------------------------------

// prosopon is a toggle over a set, so it takes one name. Passing two used to read args[0] only:
// `prosopon teacher greek` toggled teacher OFF, dropped "greek", and printed a success line.
test('a project persona directory is searched before the shipped one', () => {
  const { stateDir, personasDir } = tempDirs();
  const projectDir = makeTempDir('project-personas');
  fs.writeFileSync(path.join(projectDir, 'blunt.md'), '# Blunt\n');
  fs.writeFileSync(path.join(projectDir, 'teacher.md'), '# Project teacher\n');

  const dirs = [projectDir, personasDir];
  const result = prosopon({ stateDir, personasDir: dirs, name: 'blunt' });

  assert.deepEqual(result.available, ['blunt', 'greek', 'teacher']);
  assert.deepEqual(result.active, ['blunt']);
});
