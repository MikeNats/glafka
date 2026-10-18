import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { glafkaClient, endedRuns, lastResult, agentCommandFor, isTicketChange } from '../src/index';
import { FAKE_GLAFKA, fakeGlafkaDir } from './support/fakeGlafka';
import { makeGlafkaTicket } from './support/ticket';

let fake: ReturnType<typeof fakeGlafkaDir>;
let project: string;
const glafka = glafkaClient(FAKE_GLAFKA);

beforeEach(() => {
  fake = fakeGlafkaDir();
  project = mkdtempSync(path.join(tmpdir(), 'elaia-project-'));
});

describe('glafka client', { timeout: 20_000 }, () => {
  it('reads every open ticket with poreia --all --json, inside the project', async () => {
    fake.answer('poreia', { contract: 1, tickets: [makeGlafkaTicket()] });
    const tickets = await glafka.tickets(project);
    expect(tickets.map((t) => t.id)).toEqual(['2026-10-13-add-csv-export']);
    expect(fake.calls()[0]).toMatch(/\tporeia --all --json$/);
    expect(fake.calls()[0]?.split('\t')[0]).toContain('elaia-project-');
  });

  it('creates a ticket and returns its id', async () => {
    fake.answer('create', { contract: 1, id: '2026-10-13-x', position: 'brainstorming' });
    expect(await glafka.create(project, 'add x')).toBe('2026-10-13-x');
    expect(fake.calls()[0]).toMatch(/\tcreate add x --json$/);
  });

  it('keeps vima results even when vima exits 1', async () => {
    fake.answer('vima', { contract: 1, results: [{ id: 'a', action: 'error', reason: 'r' }] }, 1);
    expect(await glafka.advance(project, 'a')).toEqual([{ kind: 'error', reason: 'r' }]);
  });

  it('reads token rows from audit --json', async () => {
    fake.answer('audit', {
      schema: 3,
      tickets: [
        { ticket: 'a', runs: 2, durationMs: 10, tokensIn: 5, tokensOut: 6, tokensCacheRead: 7 },
      ],
      byRole: [],
    });
    expect((await glafka.tokens(project))[0]).toMatchObject({ ticket: 'a', tokensCacheRead: 7 });
  });

  it('says what to do when glafka is too old to print JSON', async () => {
    writeFileSync(path.join(fake.dir, 'poreia.json'), 'ticket-a  planned\n');
    await expect(glafka.tickets(project)).rejects.toThrow(/update glafka/i);
  });

  it('says what to do when glafka is not installed', async () => {
    await expect(glafkaClient('/no/such/glafka').tickets(project)).rejects.toThrow(/GLAFKA_BIN/);
  });
});

describe('glafka run files', () => {
  it('lists runs that ended and reads their last result', () => {
    const runs = path.join(project, '.glafka', 'tickets', 't1', 'runs');
    mkdirSync(path.join(runs, 'coder'), { recursive: true });
    mkdirSync(path.join(runs, 'reviewer'), { recursive: true });
    writeFileSync(
      path.join(runs, 'coder', 'log'),
      '{"type":"result","result":"All 4 tasks done."}\n',
    );
    writeFileSync(path.join(runs, 'coder', 'exit-code'), '0');
    writeFileSync(path.join(runs, 'coder', 'started-at'), '1700000000000');
    writeFileSync(path.join(runs, 'reviewer', 'log'), 'still going');
    const ended = endedRuns(project, 't1');
    expect(ended).toEqual([
      {
        role: 'coder',
        startedAt: '1700000000000',
        log: path.join(runs, 'coder', 'log'),
        exitCode: 0,
      },
    ]);
    expect(lastResult(ended[0]!.log)).toBe('All 4 tasks done.');
  });

  it('finds the agent command for other CLIs in .glafka.json', () => {
    writeFileSync(
      path.join(project, '.glafka.json'),
      JSON.stringify({ agents: { default: 'gemini -p' } }),
    );
    expect(agentCommandFor(project, '')).toBe('gemini -p');
    expect(agentCommandFor(project, 'kimi --print')).toBe('kimi --print');
  });

  it('counts only the files that mean a ticket changed', () => {
    expect(isTicketChange('tickets/t1/ticket.json')).toBe(true);
    expect(isTicketChange('tickets/t1/stages')).toBe(true);
    expect(isTicketChange('tickets/t1/runs/coder/exit-code')).toBe(true);
    expect(isTicketChange('tickets/t1/runs/coder/log')).toBe(false);
    expect(isTicketChange('audit/t1.jsonl')).toBe(false);
  });
});
