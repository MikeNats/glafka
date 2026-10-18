import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runGlafka } from '../src/run';
import { setupAnswer } from '../src/setupAnswer';
import { setupAsk as ask, setupProject } from './support/setupProject';

// glafka itself is faked: `prosopon` says which personas there are, the rest just works.
vi.mock('../src/run', () => ({ runGlafka: vi.fn() }));
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
let persona = 'active: (none)\navailable: creative, dyslexic, teacher';
let repo: ReturnType<typeof setupProject>;
const calls = () => vi.mocked(runGlafka).mock.calls.map((c) => c[1].join(' '));

beforeEach(() => {
  repo = setupProject();
  persona = 'active: (none)\navailable: creative, dyslexic, teacher';
  vi.mocked(runGlafka).mockReset();
  vi.mocked(runGlafka).mockImplementation(async (_bin, args) =>
    args[0] === 'prosopon' && args.length === 1 ? ok(persona) : ok(),
  );
});

describe('setup-answer', () => {
  it('a persona glafka has is turned on', async () => {
    repo.setUp();
    const answers = { start: 'yes', persona: 'dyslexic' };
    const reply = await setupAnswer('glafka', repo.project, {
      ...ask(answers),
      id: 'persona',
      choice: 'dyslexic',
    });
    expect(calls()).toContain('prosopon dyslexic');
    expect(reply.said[0]).toBe('Persona: dyslexic.');
  });

  it('a persona glafka does not have runs nothing', async () => {
    repo.setUp();
    const answers = { start: 'yes', persona: 'pirate' };
    const reply = await setupAnswer('glafka', repo.project, {
      ...ask(answers),
      id: 'persona',
      choice: 'pirate',
    });
    expect(calls()).not.toContain('prosopon pirate');
    expect(reply.said[0]).toBe('glafka has no persona called pirate.');
  });

  it('Explain on guardrails hands over to the main chat', async () => {
    repo.setUp();
    const answers = { start: 'yes', persona: 'none', guardrails: 'explain' };
    const reply = await setupAnswer('glafka', repo.project, {
      ...ask(answers),
      id: 'guardrails',
      choice: 'explain',
    });
    expect(reply.step).toMatchObject({ kind: 'agent', id: 'guardrails-explain' });
  });
});
