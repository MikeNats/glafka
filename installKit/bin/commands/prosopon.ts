import { prosopon } from '../../../src/commands/prosopon/prosopon.js';
import type { PersonasDir } from '../../../src/memory/persona.js';
import { assertKnownFlags } from '../cli/args.js';

// Every flag this command reads. Anything else is a typo, and a typo used to be silently ignored —
// sometimes into a different action entirely.
const PROSOPON_FLAGS = ['--clear'];
const PROSOPON_USAGE =
  'usage: glafka prosopon [<name>]\n       glafka prosopon --clear   turn every persona off';

export function runProsopon({
  args,
  stateDir,
  personasDir,
}: {
  args: string[];
  stateDir: string;
  personasDir: PersonasDir;
}): void {
  assertKnownFlags(args, PROSOPON_FLAGS, PROSOPON_USAGE);
  const clear = args.includes('--clear');
  const names = args.filter((arg) => !arg.startsWith('--'));
  // Only args[0] used to be read, so `prosopon teacher greek` toggled teacher OFF, dropped "greek", and
  // reported success. Naming one at a time is the whole interface; refusing is the only honest answer to two.
  if (!clear && names.length > 1) {
    throw new Error(
      `usage: glafka prosopon [<persona>]            show, or turn one on/off\n` +
        `       glafka prosopon --clear                turn them all off\n` +
        `\nThis is a toggle, and it takes one name. You gave ${names.length}: ${names.join(', ')}.\n` +
        `Only one persona is active at a time — naming a new one replaces the active one.`,
    );
  }
  const name = clear ? undefined : names[0];
  const before = prosopon({ stateDir, personasDir }).active;
  const result = prosopon({ stateDir, personasDir, name, clear });
  // Say what changed. "active: teacher" alone never told you whether this run
  // turned it on or off.
  if (name) {
    console.log(`${name}: ${result.active.includes(name) ? 'on' : 'off'}`);
  } else if (clear && before.length > 0) {
    console.log(`turned off: ${before.join(', ')}`);
  }
  console.log(`active: ${result.active.length ? result.active.join(', ') : '(none)'}`);
  console.log(`available: ${result.available.join(', ')}`);
}
