import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDir } from '../helpers/tempDir.js';
import {
  listPersonas,
  setActivePersona,
  clearActivePersonas,
  getActivePersonas,
  loadPersonaContent,
  loadActivePersonaContent,
} from '../../src/memory/persona.js';

function tempDirs() {
  const stateDir = makeTempDir('state');
  const personasDir = makeTempDir('personas');
  fs.writeFileSync(path.join(personasDir, 'teacher.md'), '# Teacher\nExplain deeply.\n');
  fs.writeFileSync(path.join(personasDir, 'dyslexic.md'), '# Dyslexic\nShort chunks.\n');
  fs.writeFileSync(path.join(personasDir, 'greek.md'), '# Greek\nAnswer in Greek.\n');
  return { stateDir, personasDir };
}

test('listPersonas returns sorted persona names from .md files', () => {
  const { personasDir } = tempDirs();
  assert.deepEqual(listPersonas(personasDir), ['dyslexic', 'greek', 'teacher']);
});

test('getActivePersonas is empty before any persona is toggled on', () => {
  const { stateDir } = tempDirs();
  assert.deepEqual(getActivePersonas(stateDir), []);
});

test('setActivePersona turns a persona on', () => {
  const { stateDir, personasDir } = tempDirs();
  setActivePersona(stateDir, personasDir, 'teacher');
  assert.deepEqual(getActivePersonas(stateDir), ['teacher']);
});

test('naming the active persona again turns it off', () => {
  const { stateDir, personasDir } = tempDirs();
  setActivePersona(stateDir, personasDir, 'teacher');
  setActivePersona(stateDir, personasDir, 'teacher');
  assert.deepEqual(getActivePersonas(stateDir), []);
});

// Each persona carries its own reply template now. Two of them in one prompt compete —
// `creative` asks for two or three directions before picking, `dyslexic` for one answer
// and then stop — and nothing decides which wins.
test('picking a second persona replaces the first', () => {
  const { stateDir, personasDir } = tempDirs();
  setActivePersona(stateDir, personasDir, 'dyslexic');
  setActivePersona(stateDir, personasDir, 'teacher');
  assert.deepEqual(getActivePersonas(stateDir), ['teacher']);
});

// The file is still a list, so a project that had two active before this change reads
// fine. The next selection collapses it to one.
test('an older two-persona file still reads, and the next pick collapses it', () => {
  const { stateDir, personasDir } = tempDirs();
  fs.writeFileSync(path.join(stateDir, 'persona'), 'dyslexic\nteacher\n');
  assert.deepEqual(getActivePersonas(stateDir), ['dyslexic', 'teacher']);

  setActivePersona(stateDir, personasDir, 'greek');
  assert.deepEqual(getActivePersonas(stateDir), ['greek']);
});

test('setActivePersona rejects a persona with no matching file', () => {
  const { stateDir, personasDir } = tempDirs();
  assert.throws(() => setActivePersona(stateDir, personasDir, 'ghost'), /unknown persona "ghost"/);
});

test('clearActivePersonas empties the active set', () => {
  const { stateDir, personasDir } = tempDirs();
  setActivePersona(stateDir, personasDir, 'dyslexic');
  clearActivePersonas(stateDir);
  assert.deepEqual(getActivePersonas(stateDir), []);
});

test("loadPersonaContent returns the persona file's raw markdown", () => {
  const { personasDir } = tempDirs();
  const content = loadPersonaContent(personasDir, 'teacher');
  assert.match(content, /Explain deeply/);
});

test('loadActivePersonaContent is null when no persona is active', () => {
  const { stateDir, personasDir } = tempDirs();
  assert.equal(loadActivePersonaContent(stateDir, personasDir), null);
});

test("loadActivePersonaContent returns the active persona's content", () => {
  const { stateDir, personasDir } = tempDirs();
  setActivePersona(stateDir, personasDir, 'dyslexic');

  assert.match(loadActivePersonaContent(stateDir, personasDir)!, /Short chunks/);
});
