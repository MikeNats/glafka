import { describe, expect, it } from 'vitest';
import { glafkaTrust } from '../src/index';

const ISO = 'docs/glafka/architecture/isolation.json';

describe('glafkaTrust', () => {
  it('reads .glafka.json and isolation.json', () => {
    expect(glafkaTrust.trustFiles).toEqual(['.glafka.json', ISO]);
    expect(glafkaTrust.runnables('.glafka.json', { checksCmd: 'npm test' })).toHaveLength(1);
  });

  it('lists every agent and every key that ends in Cmd', () => {
    const json = {
      agents: { coder: 'claude -p', reviewer: 'claude -p --allowedTools Read' },
      baseRef: 'main',
      checksCmd: 'npm test',
    };
    expect(glafkaTrust.runnables('.glafka.json', json)).toEqual([
      { file: '.glafka.json', what: 'agents.coder', run: 'claude -p' },
      { file: '.glafka.json', what: 'agents.reviewer', run: 'claude -p --allowedTools Read' },
      { file: '.glafka.json', what: 'checksCmd', run: 'npm test' },
    ]);
  });

  it('finds Cmd keys at any depth, with their path', () => {
    const json = {
      workspace: { checksCmd: 'npm run check', e2eCmd: 'npm run e2e' },
      services: [{ name: 'db', setupCmd: 'docker compose up -d', devCmd: 'npm run dev' }],
      teardownCmd: 'docker compose down',
    };
    expect(glafkaTrust.runnables(ISO, json).map((r) => `${r.what}=${r.run}`)).toEqual([
      'workspace.checksCmd=npm run check',
      'workspace.e2eCmd=npm run e2e',
      'services.0.setupCmd=docker compose up -d',
      'services.0.devCmd=npm run dev',
      'teardownCmd=docker compose down',
    ]);
  });

  it('lists nothing for settings that run nothing', () => {
    expect(glafkaTrust.runnables('.glafka.json', { baseRef: 'main' })).toEqual([]);
  });
});
