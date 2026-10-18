import { describe, expect, it, vi } from 'vitest';
import { handlers } from '../src/handlers';
import { runGlafka } from '../src/run';

vi.mock('../src/run', () => ({
  runGlafka: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
}));

const run = handlers('glafka');
const ID = '2026-10-13-add-csv-export';

describe('every call checks its names first', () => {
  it.each([
    ['close', { id: '--sweep' }],
    ['cancel', { id: 'a/../b' }],
    ['start-build', { id: '' }],
    ['next', { id: 7 }],
    ['ticket', { id: 'x'.repeat(201) }],
    ['install', { platform: '--force' }],
    ['keep-finding', { key: '-x' }],
    ['runs', { ids: [ID, '--all'] }],
    ['plan-prompt', { ticket: { id: '--all', title: 't', brief: 'b', epic: null } }],
    ['ticket-rules', { place: { id: '../x', title: 't', worktree: null, branch: null } }],
  ] as const)('%s refuses %j in plain words, and runs nothing', async (call, args) => {
    vi.mocked(runGlafka).mockClear();
    await expect(async () => run[call]('/p', args)).rejects.toThrow(/must be a plain name/);
    expect(runGlafka).not.toHaveBeenCalled();
  });

  it('says what is missing when a call gets the wrong shape', async () => {
    await expect(async () => run['ticket-rules']('/p', { place: 'x' })).rejects.toThrow(
      '"place" is not in the shape Elaia sends.',
    );
    await expect(async () => run.create('/p', { idea: ' ' })).rejects.toThrow(
      '"idea" must be some text.',
    );
    await expect(async () => run.create('/p', { idea: '--all' })).rejects.toThrow(
      '"idea" must not start with "-".',
    );
  });
});

describe('start-build', () => {
  it('waits at least 10 minutes for glafka', async () => {
    vi.mocked(runGlafka).mockClear();
    await run['start-build']('/p', { id: ID });
    const timeout = vi.mocked(runGlafka).mock.calls[0]?.[3] ?? 0;
    expect(timeout).toBeGreaterThanOrEqual(600_000);
  });
});
