import { describe, expect, it } from 'vitest';
import { toTicket } from '../src/toTicket';
import { makeGlafkaTicket } from './support/ticket';

const ID = '2026-10-13-add-csv-export';
const READY = { rank: 0, text: `${ID}  ✔ ready for you  — clean` };
const CLEAN = {
  status: { state: 'finished' },
  findings: [],
  verdict: { source: 'krisis', verdict: 'clean', finding: null },
};
const CRITERIA = [
  { id: 'AC-1', text: 'a' },
  { id: 'AC-2', text: 'b' },
];
const stage = (at: string) => ({ at, stage: 'ergon', note: null });
const result = (id: string) => ({ id, result: 'pass', evidence: 'e', verified: true });
const round = (outcome: string | null, results = [result('AC-1'), result('AC-2')]) => ({
  outcome,
  openedAt: '2026-10-17T12:00:00Z',
  results,
});
const reviewed = { criteria: CRITERIA, review: CLEAN, summary: READY };

describe('toTicket: ready only when glafka would push', () => {
  it('is ready when glafka says the QA pass covers this code', () => {
    const t = makeGlafkaTicket({ ...reviewed, qa: round('passed'), qaGap: null });
    expect(toTicket(t)).toMatchObject({ stage: 'ready', waitsForYou: null });
  });

  it('waits, with a plain reason, when the code changed after QA passed', () => {
    const gap = 'the code changed after the criteria passed: ?? later.txt';
    // The QA round opened after the last coder run: only glafka's own check sees the edit.
    const t = makeGlafkaTicket({
      ...reviewed,
      qa: round('passed'),
      qaGap: gap,
      stages: [stage('2026-10-17T11:00:00Z')],
    });
    expect(toTicket(t)).toMatchObject({
      stage: 'testing',
      working: false,
      waitsForYou: `QA passed, but not on this code: ${gap}. Press Next step to check it again.`,
      personSteps: [],
    });
  });

  it('is not ready while glafka still sees a gap, whatever QA said', () => {
    const t = makeGlafkaTicket({ ...reviewed, qa: round('failed'), qaGap: 'AC-1 failed' });
    expect(toTicket(t).stage).toBe('testing');
  });
});

describe('toTicket: a check by hand (no QA agent)', () => {
  const noAgent = { bin: 'glafka', hasVerifier: false };

  it('is not working: it waits for you, with the step to start it again', () => {
    const t = makeGlafkaTicket({ ...reviewed, qa: round(null, [result('AC-1')]), qaGap: 'open' });
    expect(toTicket(t, noAgent)).toMatchObject({
      stage: 'testing',
      working: false,
      summary: 'review clean — a check by hand is open',
      qa: { state: 'running' },
      waitsForYou:
        'A check by hand is open: record a result for AC-2 with the commands it printed in your terminal.',
      personSteps: [
        { label: 'Start the check by hand again', command: `glafka ergon ${ID} --review` },
      ],
    });
  });

  it('says Next step finishes it once every criterion has a result', () => {
    const t = makeGlafkaTicket({ ...reviewed, qa: round(null), qaGap: 'open' });
    expect(toTicket(t, noAgent).waitsForYou).toBe(
      'A check by hand is open, and every criterion has a result: press Next step to finish it.',
    );
  });

  it('quotes a glafka path with a space or a quote in it', () => {
    const t = makeGlafkaTicket({ ...reviewed, qa: round(null), qaGap: 'open' });
    const ctx = { bin: "/opt/bob's tools/glafka", hasVerifier: false };
    expect(toTicket(t, ctx).personSteps[0]?.command).toBe(
      `'/opt/bob'\\''s tools/glafka' ergon ${ID} --review`,
    );
  });

  it('is a QA agent at work when one is set', () => {
    const t = makeGlafkaTicket({ ...reviewed, qa: round(null, []), qaGap: 'open' });
    expect(toTicket(t, { bin: 'glafka', hasVerifier: true })).toMatchObject({
      working: true,
      waitsForYou: null,
    });
  });
});
