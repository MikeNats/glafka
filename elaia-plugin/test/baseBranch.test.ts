import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { baseRefFor } from '../src/config';

interface GlafkaConfig {
  loadConfig(repoRoot: string): { baseRef: string | null };
  resolveBaseRef(a: { repoRoot: string; config: object; profile: unknown }): string;
}
interface GlafkaDocs {
  readIsolationProfile(repoRoot: string): unknown;
}
// glafka's own code, loaded when the test runs: the plugin's type check is stricter than glafka's.
const glafkaFile = (file: string) => new URL(`../../src/${file}`, import.meta.url).pathname;

// The base branch exactly as the glafka CLI finds it before every command.
async function glafkaBaseRef(repoRoot: string): Promise<string> {
  const { loadConfig, resolveBaseRef } = (await import(glafkaFile('config.ts'))) as GlafkaConfig;
  const docs = (await import(glafkaFile('memory/docsStore.ts'))) as GlafkaDocs;
  const profile = docs.readIsolationProfile(repoRoot);
  return resolveBaseRef({ repoRoot, config: loadConfig(repoRoot), profile });
}

const SCAN = 'docs/glafka/architecture/isolation.json';

function repo(branch: string, files: Record<string, unknown> = {}, commit = true) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'elaia-base-')));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '-b', branch);
  if (commit)
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'i');
  for (const [file, json] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), JSON.stringify(json));
  }
  return { dir, git };
}

describe('the base branch, found the way glafka finds it', () => {
  it.each([
    ['your setting first', repo('main', { '.glafka.json': { baseRef: 'develop' } }).dir, 'develop'],
    [
      'the scan, when your setting is null',
      repo('main', { '.glafka.json': { baseRef: null }, [SCAN]: { workspace: { baseRef: 'rel' } } })
        .dir,
      'rel',
    ],
    ['master when there is no main', repo('master').dir, 'master'],
    ['trunk', repo('trunk').dir, 'trunk'],
    ['the current branch', repo('work').dir, 'work'],
    ['main in a repo with no commit yet', repo('dev', {}, false).dir, 'main'],
  ])('%s', async (_what, dir, expected) => {
    expect(baseRefFor(dir)).toBe(expected);
    expect(baseRefFor(dir)).toBe(await glafkaBaseRef(dir));
  });

  it("origin's own default branch", async () => {
    const { dir, git } = repo('main');
    git('update-ref', 'refs/remotes/origin/stable', 'HEAD');
    git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/stable');
    expect(baseRefFor(dir)).toBe('stable');
    expect(baseRefFor(dir)).toBe(await glafkaBaseRef(dir));
  });
});
