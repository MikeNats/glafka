import type { PersonasDir } from '../../../src/memory/persona.js';
import type { Config } from '../../../src/types/config.js';
import type { IsolationProfile } from '../../../src/types/isolationProfile.js';

// Built once at start up and passed to every command.
// Each command asks only for the fields it really reads.
export interface CommandContext {
  args: string[];
  repoRoot: string;
  stateDir: string;
  config: Config;
  personaContent: string | null;
  profile: IsolationProfile | null;
  packageRoot: string;
  personasDir: PersonasDir;
}
