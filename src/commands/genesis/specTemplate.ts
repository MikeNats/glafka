// The shape every spec is written in. genesis.md carries the same text,
// and test/commands/specPrompt.test.ts fails if the two drift apart.
export const SPEC_TEMPLATE = `# <title> — spec

## Why

<the problem, in plain words>

## 1. <what changes> — \`path/to/file.ts:26\`

<the code — first, before any prose>

**Why <chosen>, not <rejected>:**

- the fact that rules the alternative out

## Out of scope

- <named, tied back to what was chosen>

## Acceptance criteria

- AC-1: <start state> → <action> → <what you see>
- AC-2: <start state> → <action> → <what you see>`;
