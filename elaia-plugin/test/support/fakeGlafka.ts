import { chmodSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FAKE_GLAFKA = fileURLToPath(new URL('../fixtures/fake-glafka.mjs', import.meta.url));
chmodSync(FAKE_GLAFKA, 0o755);

// A temp folder the fake glafka answers from. Set FAKE_GLAFKA_DIR before running it.
export function fakeGlafkaDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'elaia-fake-glafka-'));
  process.env.FAKE_GLAFKA_DIR = dir;
  return {
    dir,
    answer(command: string, json: unknown, code = 0) {
      writeFileSync(path.join(dir, `${command}.json`), JSON.stringify(json));
      writeFileSync(path.join(dir, `${command}.code`), String(code));
    },
    // Files `command` writes into the folder it runs in, by relative path: like a real install.
    writes(command: string, files: Record<string, string>) {
      writeFileSync(path.join(dir, `${command}.writes.json`), JSON.stringify(files));
    },
    calls(): string[] {
      const file = path.join(dir, 'calls.log');
      return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n') : [];
    },
  };
}
