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

describe('toTicket: steps only a person may do', () => {
  const waiting = { rank: 0, text: `${ID}  ⚠ needs you  — QA could not check AC-4` };
  const result = (id: string, r: string) => ({ id, result: r, evidence: 'e', verified: true });

  it('offers to skip, in a terminal, every check QA could not do', () => {
    const t = toTicket(
      makeGlafkaTicket({
        summary: waiting,
        criteria: [...CRITERIA, { id: 'AC-4', text: 'c' }, { id: 'AC-5', text: 'd' }],
        qa: {
          outcome: 'cannot',
          results: [result('AC-1', 'pass'), result('AC-4', 'cannot'), result('AC-5', 'cannot')],
        },
      }),
    );
    expect(t.personSteps).toEqual([
      {
        label: 'Skip the 2 checks QA could not do',
        command:
          `glafka epalitheusis ${ID} --skip AC-4 --reason "could not be checked here" && ` +
          `glafka epalitheusis ${ID} --skip AC-5 --reason "could not be checked here"`,
      },
    ]);
  });

  it('offers to check it by hand when there is no QA agent', () => {
    const summary = {
      rank: 0,
      text: `${ID}  ⚠ needs you  — no verifier agent configured — verify manually: glafka ergon ${ID} --review at a real terminal — needs you`,
    };
    expect(toTicket(makeGlafkaTicket({ summary })).personSteps).toEqual([
      { label: 'Check it by hand', command: `glafka ergon ${ID} --review` },
    ]);
  });

  it('offers nothing while it does not wait for you', () => {
    const qa = { outcome: null, results: [result('AC-4', 'cannot')] };
    expect(toTicket(makeGlafkaTicket({ qa })).personSteps).toEqual([]);
  });
});

describe('toTicket: QA must have run on this code', () => {
  const stage = (stage: string, at: string) => ({ at, stage, note: null });
  const passedAt = (openedAt: string) => ({ outcome: 'passed', openedAt, results: [] });

  it('is not ready when the coder ran again after QA passed', () => {
    const t = makeGlafkaTicket({
      criteria: CRITERIA,
      review: CLEAN,
      summary: READY,
      qa: passedAt('2026-10-17T10:00:00Z'),
      stages: [stage('ergon', '2026-10-17T09:00:00Z'), stage('ergon', '2026-10-17T11:00:00Z')],
    });
    expect(toTicket(t)).toMatchObject({
      stage: 'testing',
      summary: 'review clean — QA has not checked it yet',
    });
  });

  it('is ready when QA passed after the last coder run', () => {
    const t = makeGlafkaTicket({
      criteria: CRITERIA,
      review: CLEAN,
      summary: READY,
      qa: passedAt('2026-10-17T12:00:00Z'),
      stages: [stage('ergon', '2026-10-17T11:00:00Z')],
    });
    expect(toTicket(t).stage).toBe('ready');
  });

  it('counts a QA run as working, and says so', () => {
    const t = makeGlafkaTicket({
      criteria: CRITERIA,
      review: CLEAN,
      summary: READY,
      qa: { outcome: null, openedAt: 'x', results: [] },
    });
    expect(toTicket(t)).toMatchObject({
      working: true,
      summary: 'QA is checking the acceptance criteria',
    });
  });

  it('with no QA agent: waits for you, with Check it by hand using your glafka', () => {
    const t = makeGlafkaTicket({ criteria: CRITERIA, review: CLEAN, summary: READY });
    expect(toTicket(t, { bin: '/opt/glafka', hasVerifier: false })).toMatchObject({
      stage: 'testing',
      waitsForYou: 'No QA agent is set: check the acceptance criteria by hand.',
      personSteps: [{ label: 'Check it by hand', command: `/opt/glafka ergon ${ID} --review` }],
    });
    expect(toTicket(t, { bin: 'glafka', hasVerifier: true }).waitsForYou).toBeNull();
  });
});
