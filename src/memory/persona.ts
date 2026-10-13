import fs from 'node:fs';
import path from 'node:path';
import { writeFile } from '../util/fileOperations.js';

// Active personas are stored as one name per line.
// The text for each one lives in its own file.

function activePersonaFile(stateDir: string): string {
  return path.join(stateDir, 'persona');
}

function readActiveList(stateDir: string): string[] {
  const filePath = activePersonaFile(stateDir);
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

// One dir or several, earliest wins. A project's own personas live in docs/glafka/personas/ —
// git-tracked, so a team shares them — and the ones glafka ships live in the vendored
// .glafka/personas/, which is git-ignored and therefore private to one machine.
export type PersonasDir = string | readonly string[];

function personaDirs(personasDir: PersonasDir): string[] {
  return (typeof personasDir === 'string' ? [personasDir] : [...personasDir]).filter((dir) =>
    fs.existsSync(dir),
  );
}

export function listPersonas(personasDir: PersonasDir): string[] {
  const seen = new Set<string>();
  for (const dir of personaDirs(personasDir)) {
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.md')) seen.add(name.replace(/\.md$/, ''));
    }
  }
  return [...seen].sort();
}

// One at a time. Naming a different persona replaces the active one; naming the active one turns it
// off. They used to stack, which was fine while a persona only set tone — now each carries its own
// reply template, and two of those in one prompt compete with nothing deciding which wins.
export function setActivePersona(
  stateDir: string,
  personasDir: PersonasDir,
  name: string,
): string[] {
  const available = listPersonas(personasDir);
  if (!available.includes(name)) {
    throw new Error(`unknown persona "${name}" (available: ${available.join(', ') || 'none'})`);
  }
  // Still written as a list, so a file left over from when several could be on still reads.
  const next = readActiveList(stateDir).includes(name) ? [] : [name];
  writeFile(activePersonaFile(stateDir), next.join('\n'));
  return next;
}

export function clearActivePersonas(stateDir: string): void {
  writeFile(activePersonaFile(stateDir), '');
}

export function getActivePersonas(stateDir: string): string[] {
  return readActiveList(stateDir);
}

export function loadPersonaContent(personasDir: PersonasDir, name: string): string {
  for (const dir of personaDirs(personasDir)) {
    const filePath = path.join(dir, `${name}.md`);
    if (fs.existsSync(filePath)) return fs.readFileSync(filePath, 'utf8');
  }
  throw new Error(`persona "${name}" has no file in ${personaDirs(personasDir).join(', ')}`);
}

// Joins the text of every active persona. Null if none are on.
export function loadActivePersonaContent(
  stateDir: string,
  personasDir: PersonasDir,
): string | null {
  const names = getActivePersonas(stateDir);
  if (names.length === 0) return null;
  return names.map((name) => loadPersonaContent(personasDir, name)).join('\n\n');
}
