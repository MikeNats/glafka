import { describe, expect, it } from 'vitest';
import { runOf, toNextEvent } from '../src/next';

describe('toNextEvent: glafka vima results in plain events', () => {
  it('maps what vima started', () => {
    expect(toNextEvent({ id: 'a', action: 'spawned-reviewer' })).toEqual({
      kind: 'started',
      what: 'review',
    });
    expect(toNextEvent({ id: 'a', action: 'spawned-verifier' })).toMatchObject({ what: 'qa' });
    expect(toNextEvent({ id: 'a', action: 'spawned-coder', reason: 'r' })).toEqual({
      kind: 'started',
      what: 'fix',
      reason: 'r',
    });
  });

  it('maps an error, a stop that waits for you, and anything else', () => {
    expect(toNextEvent({ id: 'a', action: 'error', reason: 'boom' })).toEqual({
      kind: 'error',
      reason: 'boom',
    });
    expect(toNextEvent({ id: 'a', action: 'none', reason: 'x — needs you' })).toEqual({
      kind: 'waits',
      reason: 'x — needs you',
    });
    expect(toNextEvent({ id: 'a', action: 'none', reason: 'review manually: y' })).toMatchObject({
      kind: 'waits',
    });
    expect(toNextEvent({ id: 'a', action: 'ready', reason: 'clean' })).toEqual({
      kind: 'other',
      text: 'ready — clean',
    });
  });
});

describe('runOf: glafka run folders in plain roles', () => {
  it('names the roles and keeps a stable key per run', () => {
    const run = { role: 'coder', startedAt: '17', log: '/l', exitCode: 0 };
    expect(runOf(run)).toEqual({ ...run, role: 'build', key: 'coder-17' });
    expect(runOf({ ...run, role: 'reviewer' }).role).toBe('review');
    expect(runOf({ ...run, role: 'verifier' }).role).toBe('qa');
    expect(runOf({ ...run, role: 'odd' }).role).toBe('odd');
  });
});
