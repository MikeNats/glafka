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
const qaRound = (outcome: string | null) => ({ outcome, openedAt: 'x', results: [] });

describe('toTicket: the stage', () => {
  it('reads closed, cancelled and pushed first', () => {
    expect(toTicket(makeGlafkaTicket({ closed: true, cancelled: true })).stage).toBe('cancelled');
    expect(toTicket(makeGlafkaTicket({ closed: true })).stage).toBe('closed');
    expect(toTicket(makeGlafkaTicket({ pushed: true, summary: READY })).stage).toBe('pushed');
  });

  it('is building while the coder runs', () => {
    const t = makeGlafkaTicket({ coder: { state: 'running' }, summary: { rank: 1, text: 'x' } });
    expect(toTicket(t)).toMatchObject({ stage: 'building', builder: 'running', working: true });
  });

  it('is reviewing while a reviewer reads', () => {
    const review = { ...CLEAN, status: { state: 'running' }, verdict: { source: 'not-done' } };
    expect(toTicket(makeGlafkaTicket({ review })).stage).toBe('reviewing');
  });

  it('is testing while a QA round is open', () => {
    const t = makeGlafkaTicket({ criteria: CRITERIA, qa: qaRound(null), review: CLEAN });
    expect(toTicket(t)).toMatchObject({ stage: 'testing', qa: { state: 'running' } });
  });

  it('is not ready when the review is clean but QA has not run', () => {
    const t = makeGlafkaTicket({ criteria: CRITERIA, review: CLEAN, summary: READY });
    expect(toTicket(t).stage).toBe('testing');
  });

  it('is ready once QA passed', () => {
    const t = makeGlafkaTicket({
      criteria: CRITERIA,
      review: CLEAN,
      summary: READY,
      qa: qaRound('passed'),
    });
    expect(toTicket(t)).toMatchObject({ stage: 'ready', qa: { state: 'passed' } });
  });

  it('is ready with no criteria to check, or when a person skipped them all', () => {
    expect(toTicket(makeGlafkaTicket({ review: CLEAN, summary: READY })).stage).toBe('ready');
    const skipped = makeGlafkaTicket({
      criteria: CRITERIA,
      criteriaSkips: [{ id: 'AC-1' }, { id: 'AC-2' }],
      review: CLEAN,
      summary: READY,
    });
    expect(toTicket(skipped).stage).toBe('ready');
  });

  it('is planned, building, planning or new from the plan, commits and spec', () => {
    expect(toTicket(makeGlafkaTicket()).stage).toBe('planned');
    expect(toTicket(makeGlafkaTicket({ steps: ['feat: a'] })).stage).toBe('building');
    expect(toTicket(makeGlafkaTicket({ planned: false })).stage).toBe('planning');
    expect(toTicket(makeGlafkaTicket({ planned: false, specPath: null })).stage).toBe('new');
  });
});

describe('toTicket: the facts', () => {
  it('says why it waits for you', () => {
    const summary = { rank: 0, text: `${ID}  ⚠ needs you  — checks failed` };
    expect(toTicket(makeGlafkaTicket({ summary })).waitsForYou).toBe('checks failed');
    expect(toTicket(makeGlafkaTicket({ summary: READY })).waitsForYou).toBeNull();
  });

  it('keeps blocking findings and maps the review state', () => {
    const review = {
      status: { state: 'finished' },
      findings: [
        { verdict: 'blocking', finding: 'no test' },
        { verdict: 'note', finding: 'style' },
      ],
      verdict: { source: 'krisis', verdict: 'blocking', finding: 'no test' },
    };
    expect(toTicket(makeGlafkaTicket({ review })).review).toEqual({
      state: 'blocking',
      findings: ['no test'],
    });
    expect(toTicket(makeGlafkaTicket({ review: CLEAN })).review.state).toBe('clean');
  });

  it('maps the builder, checks and QA results', () => {
    const t = toTicket(
      makeGlafkaTicket({
        coder: { state: 'crashed' },
        checksOutcome: 'ok',
        qa: {
          outcome: 'failed',
          results: [{ id: 'AC-1', result: 'odd', evidence: 'e', verified: true }],
        },
      }),
    );
    expect(t).toMatchObject({ builder: 'failed', checks: 'passed', qa: { state: 'failed' } });
    expect(t.qa.results).toEqual([{ id: 'AC-1', result: 'cannot', evidence: 'e' }]);
  });
});
