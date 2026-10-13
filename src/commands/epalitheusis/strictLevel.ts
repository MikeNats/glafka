import { resolvePolicy } from '../../../installKit/guardrails/index.js';

// Levels 3 and 4 refuse curl to an agent, so the QA tester can check nothing there.
export function strictLevelWarning(repoRoot: string): string | null {
  const { level } = resolvePolicy({ repoRoot });
  if (level < 3) return null;
  return (
    `guardrails level ${level}: the QA tester cannot run curl at level 3 or 4, ` +
    `so every round will end "cannot" — QA works at levels 0–2`
  );
}
