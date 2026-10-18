import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { glafkaClient } from '../src/index';
import { FAKE_GLAFKA, fakeGlafkaDir } from './support/fakeGlafka';

let fake: ReturnType<typeof fakeGlafkaDir>;
let project: string;
const glafka = glafkaClient(FAKE_GLAFKA);

beforeEach(() => {
  fake = fakeGlafkaDir();
  project = mkdtempSync(path.join(tmpdir(), 'elaia-project-'));
});

describe('glafka client: one ticket', { timeout: 20_000 }, () => {
  // poreia fails with nothing on stdout and this on stderr.
  const fails = (stderr: string) => {
    writeFileSync(path.join(fake.dir, 'poreia.json'), '');
    writeFileSync(path.join(fake.dir, 'poreia.code'), '1');
    writeFileSync(path.join(fake.dir, 'poreia.stderr'), stderr);
  };

  it('answers null for an id glafka does not know', async () => {
    fails('no ticket "nope" — glafka poreia --all lists the tickets you have');
    expect(await glafka.ticket(project, 'nope')).toBeNull();
  });

  it('answers null for an id that cannot be a glafka id', async () => {
    fails('invalid ticket id: "epic-x"');
    expect(await glafka.ticket(project, 'epic-x')).toBeNull();
  });

  it('still fails in plain words for any other error', async () => {
    fails('ticket.json: not valid JSON');
    await expect(glafka.ticket(project, 'x')).rejects.toThrow(/glafka poreia failed .*not valid/);
  });
});
