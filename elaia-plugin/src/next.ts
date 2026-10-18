import type { FinishedRun, NextEvent } from './contract';
import type { EndedRun } from './files';

const STARTED: Record<string, 'review' | 'qa' | 'fix'> = {
  'spawned-reviewer': 'review',
  'spawned-verifier': 'qa',
  'spawned-coder': 'fix',
};
const WAITS = /needs you|review manually/;
const ROLES: Record<string, string> = { coder: 'build', reviewer: 'review', verifier: 'qa' };

// One `glafka vima --json` result as a plain event.
export function toNextEvent(r: { id: string; action: string; reason?: string }): NextEvent {
  const what = STARTED[r.action];
  if (what)
    return r.reason ? { kind: 'started', what, reason: r.reason } : { kind: 'started', what };
  if (r.action === 'error') return { kind: 'error', reason: r.reason ?? '' };
  if (r.action === 'none' && WAITS.test(r.reason ?? ''))
    return { kind: 'waits', reason: r.reason ?? '' };
  return { kind: 'other', text: `${r.action}${r.reason ? ` — ${r.reason}` : ''}` };
}

// A glafka run folder in plain roles. The key keeps glafka's role: copies made before stay found.
export const runOf = (run: EndedRun): Omit<FinishedRun, 'lastWords'> => ({
  ...run,
  role: ROLES[run.role] ?? run.role,
  key: `${run.role}-${run.startedAt}`,
});
