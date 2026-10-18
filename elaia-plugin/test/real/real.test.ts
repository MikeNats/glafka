import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connect } from '../support/connect';

// Runs the real glafka on PATH (or GLAFKA_BIN). It must be a version with --json.
const BIN = process.env.GLAFKA_BIN ?? 'glafka';
let repo: string;
const open: { close(): Promise<void> }[] = [];

function gitRepo(): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'glafka-elaia-real-')));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  return dir;
}

beforeEach(() => {
  repo = gitRepo();
});
afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close()));
});

describe('the plugin against the real glafka', () => {
  it('makes a ticket, reads it back in Elaia’s shape, and cancels it', async () => {
    const { client, call } = await connect(BIN);
    open.push(client);
    const { id } = (await call('create', repo, { idea: 'add csv export' })) as { id: string };
    expect(id).toMatch(/add-csv-export$/);
    const tickets = (await call('tickets', repo)) as { id: string; stage: string }[];
    expect(tickets.map((t) => [t.id, t.stage])).toEqual([[id, 'new']]);
    expect(await call('tokens', repo)).toEqual([]);
    const cancelled = (await call('cancel', repo, { id })) as { code: number };
    expect(cancelled.code).toBe(0);
    expect(await call('tickets', repo)).toEqual([]);
  });
});
