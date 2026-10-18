import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { endedRuns } from '../src/index';

const runsOf = (project: string) => path.join(project, '.glafka', 'tickets', 'T', 'runs');

function run(project: string, role: string, files: Record<string, string>) {
  const dir = path.join(runsOf(project), role);
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
  return dir;
}

describe('endedRuns', () => {
  it('leaves out a run it cannot read and keeps the others', () => {
    const project = mkdtempSync(path.join(tmpdir(), 'elaia-runs-'));
    const coder = run(project, 'coder', { log: 'x\n', 'exit-code': '0' });
    // A folder where the start time should be: reading it throws, like a file deleted under us.
    mkdirSync(path.join(coder, 'started-at'));
    run(project, 'reviewer', { log: 'y\n', 'exit-code': '0', 'started-at': '1700000000000' });
    expect(endedRuns(project, 'T').map((r) => r.role)).toEqual(['reviewer']);
  });

  it('gives no runs when the runs folder cannot be listed', () => {
    const project = mkdtempSync(path.join(tmpdir(), 'elaia-runs-'));
    mkdirSync(path.dirname(runsOf(project)), { recursive: true });
    writeFileSync(runsOf(project), 'not a folder');
    expect(endedRuns(project, 'T')).toEqual([]);
  });
});
