import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runGlafka } from '../src/run';
import { setupNext } from '../src/setupFlow';
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

describe('setup-next', () => {
  it('asks before anything changes, and runs nothing', async () => {
    const reply = await setupNext('glafka', repo.project, ask());
    expect(reply.step).toMatchObject({ kind: 'ask', id: 'start' });
    expect(reply.step.kind === 'ask' && reply.step.choices.map((c) => c.label)).toEqual([
      'Set up',
      'Skip',
    ]);
    expect(calls()).toEqual([]);
  });

  it('a skip stops setup', async () => {
    expect((await setupNext('glafka', repo.project, ask({ start: 'skip' }))).step).toEqual({
      kind: 'stop',
    });
  });

  it('with go: installs glafka, then asks for a persona with every one glafka has', async () => {
    const reply = await setupNext('glafka', repo.project, ask({}, true));
    expect(calls()[0]).toBe('install claude');
    expect(reply.said).toContain('glafka installed.');
    expect(reply.step).toMatchObject({ kind: 'ask', id: 'persona' });
    const labels = reply.step.kind === 'ask' ? reply.step.choices.map((c) => c.label) : [];
    expect(labels).toEqual(['creative', 'dyslexic', 'teacher', 'None']);
  });

  it('no persona question when one is already on', async () => {
    repo.setUp();
    persona = 'active: dyslexic\navailable: creative, dyslexic, teacher';
    const reply = await setupNext('glafka', repo.project, ask({}, true));
    expect(reply.step).not.toMatchObject({ id: 'persona' });
  });

  it('nothing to do: done at once, with no word', async () => {
    repo.setUp();
    repo.git('add', '-A');
    repo.git('commit', '-q', '-m', 'set up before');
    expect(await setupNext('glafka', repo.project, ask())).toEqual({
      said: [],
      step: { kind: 'done' },
    });
  });

  it("commits only setup's own files, as Set up glafka, then says done", async () => {
    repo.setUp();
    repo.write('mine.txt', 'not glafka\n');
    const reply = await setupNext(
      'glafka',
      repo.project,
      ask({ start: 'yes', persona: 'none', guardrails: 'skip' }),
    );
    expect(reply.step).toEqual({ kind: 'done' });
    expect(repo.git('log', '-1', '--format=%s')).toBe('Set up glafka');
    expect(repo.git('status', '--porcelain')).toBe('?? mine.txt');
    expect(reply.said.at(-1)).toMatch(/^Setup committed \(\w+\)\.$/);
  });
});
