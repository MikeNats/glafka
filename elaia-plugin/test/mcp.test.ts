import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CALLS } from '../src/contract';
import { connect } from './support/connect';
import { FAKE_GLAFKA, fakeGlafkaDir } from './support/fakeGlafka';
import { makeGlafkaTicket } from './support/ticket';

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close()));
});

async function plugin() {
  const fake = fakeGlafkaDir();
  const { client, call } = await connect(FAKE_GLAFKA, { FAKE_GLAFKA_DIR: fake.dir });
  open.push(client);
  return { fake, client, call };
}

describe('the plugin over MCP', () => {
  it("offers every one of Elaia's tools, and says what it is", async () => {
    const { client, call } = await plugin();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('tickets');
    expect(tools).toHaveLength(CALLS.length);
    expect(await call('describe', '')).toMatchObject({ id: 'glafka', name: 'glafka' });
  });

  it("answers tickets in Elaia's shape, from glafka's own JSON", async () => {
    const { fake, call } = await plugin();
    const project = realpathSync(mkdtempSync(path.join(tmpdir(), 'glafka-elaia-project-')));
    mkdirSync(path.join(project, '.glafka'));
    fake.answer('poreia', { contract: 1, tickets: [makeGlafkaTicket()] });
    const [ticket] = (await call('tickets', project)) as { id: string; stage: string }[];
    expect(ticket).toMatchObject({ id: '2026-10-13-add-csv-export', stage: 'planned' });
    expect(await call('detect', project)).toEqual({ installed: true });
  });

  it('reports a failure in plain words, as an error result', async () => {
    const { fake, call } = await plugin();
    const project = realpathSync(mkdtempSync(path.join(tmpdir(), 'glafka-elaia-project-')));
    fake.answer('poreia', 'not json', 1);
    await expect(call('tickets', project)).rejects.toThrow(/glafka poreia/);
  });

  it('refuses an id that is not a plain name, as an error result, before glafka runs', async () => {
    const { fake, call } = await plugin();
    await expect(call('close', '/p', { id: '--sweep' })).rejects.toThrow(
      '"id" must be a plain name: letters, digits and . _ - only.',
    );
    expect(fake.calls()).toEqual([]);
  });
});
