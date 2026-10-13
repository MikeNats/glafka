import {
  setActivePersona,
  clearActivePersonas,
  getActivePersonas,
  listPersonas,
} from '../../memory/persona.js';
import type { PersonasDir } from '../../memory/persona.js';

// Naming a persona turns it on or off.
// `clear` turns it off. Only one is active at a time — each persona carries a reply
// template now, and two of them in one prompt compete with nothing deciding which wins.
export function prosopon({
  stateDir,
  personasDir,
  name,
  clear,
}: {
  stateDir: string;
  personasDir: PersonasDir;
  name?: string;
  clear?: boolean;
}): { active: string[]; available: string[] } {
  if (clear) {
    clearActivePersonas(stateDir);
  } else if (name !== undefined) {
    setActivePersona(stateDir, personasDir, name);
  }
  return {
    active: getActivePersonas(stateDir),
    available: listPersonas(personasDir),
  };
}
