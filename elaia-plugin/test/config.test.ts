import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readConfig, readIsolation } from '../src/config';
import { hasCoder, hasVerifier } from '../src/setup';

function project(config: unknown, isolation?: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'elaia-config-'));
  writeFileSync(path.join(dir, '.glafka.json'), JSON.stringify(config));
  if (isolation !== undefined) {
    const docs = path.join(dir, 'docs', 'glafka', 'architecture');
    mkdirSync(docs, { recursive: true });
    writeFileSync(path.join(docs, 'isolation.json'), JSON.stringify(isolation));
  }
  return dir;
}

describe("glafka's settings, one field at a time", () => {
  it('keeps the agents when baseRef and checksCmd are null, as glafka allows', () => {
    const p = project({ baseRef: null, checksCmd: null, agents: { coder: 'claude -p' } });
    expect(readConfig(p)).toEqual({ agents: { coder: 'claude -p' } });
    expect(hasCoder(p)).toBe(true);
  });

  it('keeps the rest when agents is null, or a field has the wrong shape', () => {
    expect(readConfig(project({ agents: null, checksCmd: 'npm test' }))).toEqual({
      checksCmd: 'npm test',
    });
    const odd = project({ baseRef: 5, agents: { verifier: 'claude -p' } });
    expect(readConfig(odd).agents).toEqual({ verifier: 'claude -p' });
    expect(hasVerifier(odd)).toBe(true);
  });

  it('reads the scan settings field by field too', () => {
    const p = project({}, { workspace: { baseRef: null, checksCmd: 'npm run check' } });
    expect(readIsolation(p).workspace).toEqual({ checksCmd: 'npm run check' });
  });

  it('reads nothing from a file that is not JSON', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'elaia-config-'));
    writeFileSync(path.join(dir, '.glafka.json'), '{ not json');
    expect(readConfig(dir)).toEqual({});
  });
});
