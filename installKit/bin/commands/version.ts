import fs from 'node:fs';
import path from 'node:path';

// Prints the version. Handles --version, -v, and the plain "version" word.
export function printVersion({ packageRoot }: { packageRoot: string }): void {
  const { version } = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  console.log(version);
}
