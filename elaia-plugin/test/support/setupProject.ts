import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// A git repo for setup tests, and the files that make glafka count as set up.
export function setupProject() {
  const project = realpathSync(mkdtempSync(path.join(tmpdir(), 'glafka-setup-flow-')));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: project, encoding: 'utf8' }).trim();
  const write = (rel: string, text: string) => {
    mkdirSync(path.dirname(path.join(project, rel)), { recursive: true });
    writeFileSync(path.join(project, rel), text);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'T');
  git('config', 'user.email', 't@t');
  git('commit', '-q', '--allow-empty', '-m', 'start');
  // Everything setup checks is there; guardrails stay optional.
  const setUp = () => {
    write('.glafka/VERSION', '1\n');
    write('.gitignore', '.glafka/\n');
    write('docs/glafka/architecture/README.md', '# map\n');
    write(
      '.glafka.json',
      JSON.stringify({ checksCmd: 'npm test', agents: { reviewer: 'r', coder: 'c' } }),
    );
  };
  return { project, git, write, setUp };
}

export const setupAsk = (answers: Record<string, string> = {}, go = false) => ({
  answers,
  go,
  platform: 'claude',
});
