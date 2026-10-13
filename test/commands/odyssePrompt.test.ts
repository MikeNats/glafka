import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOdysseFullPrompt,
  buildOdysseUpdatePrompt,
  buildChecksProbePrompt,
} from '../../src/commands/odysse/odysse.js';
import { DEFAULT_CATEGORIES } from '../../src/memory/categories.js';

// --------------------------------------------------------------------------- The checks probe. Works
// with any language, and proves its answer by actually running it. ---------------------------------------------------------------------------

test('the checks probe trusts CI config over a language manifest', () => {
  const prompt = buildChecksProbePrompt({ repoRoot: '/repo' });

  assert.match(prompt, /\.github\/workflows/);
  assert.match(prompt, /gates merges/);
  assert.match(prompt, /trust it least/);
});

// The probe runs with nobody watching, so it must not run what it found.
// glafka runs it itself, once a person keeps it at a real terminal.
test('the checks probe finds the command but does not run it', () => {
  const prompt = buildChecksProbePrompt({ repoRoot: '/repo' });

  assert.match(prompt, /Do NOT run it/);
  assert.match(prompt, /glafka runs it\s+itself, once, when a person keeps it at a real terminal/);
});

test('the checks probe covers ecosystems beyond Node', () => {
  const prompt = buildChecksProbePrompt({ repoRoot: '/repo' });

  for (const manifest of [
    /pyproject\.toml/,
    /Cargo\.toml/,
    /go\.mod/,
    /build\.gradle/,
    /pom\.xml/,
    /mix\.exs/,
    /Gemfile/,
    /Makefile/,
  ]) {
    assert.match(prompt, manifest);
  }
});

test('the checks probe writes into the existing proposal file without clobbering it', () => {
  const prompt = buildChecksProbePrompt({ repoRoot: '/repo' });

  assert.match(prompt, /\/repo\/docs\/glafka\/architecture\/workspace\.proposed\.json/);
  assert.match(prompt, /leaving every other key exactly as it is/);
  assert.match(prompt, /"checksCmd"/);
});

test('the checks probe keeps e2e out of checksCmd and refuses to invent a command', () => {
  const prompt = buildChecksProbePrompt({ repoRoot: '/repo' });

  assert.match(prompt, /Keep e2e OUT of it/);
  assert.match(prompt, /has no automated checks" is a real and useful answer/);
});

// The full scan must not guess what the probe already checks.
test('the full odysse prompt hands checks discovery to the probe instead of guessing', () => {
  const prompt = buildOdysseFullPrompt({ tree: 'src/', repoRoot: '/repo' });

  assert.match(prompt, /Not your job here: finding how this project runs its checks/);
  assert.match(prompt, /odysse --checks/);
  assert.match(prompt, /do\s+not guess a `checksCmd`/);
});

test('buildOdysseFullPrompt embeds the tree and asks for a hierarchical, linked doc set', () => {
  const prompt = buildOdysseFullPrompt({ tree: 'src/\n  index.js', repoRoot: '/repo' });

  assert.match(prompt, /src\//);
  assert.match(prompt, /index\.js/);
  assert.match(prompt, /\/repo\/docs\/glafka\/architecture/);
  assert.match(prompt, /business logic/);
  assert.match(prompt, /README\.md/);
});

test('buildOdysseFullPrompt asks the agent to discover and write an isolation profile', () => {
  const prompt = buildOdysseFullPrompt({ tree: 'src/\n  index.js', repoRoot: '/repo' });

  assert.match(prompt, /\/repo\/docs\/glafka\/architecture\/isolation\.json/);
  assert.match(prompt, /"services"/);
  assert.match(prompt, /"setupCmd"/);
  assert.match(prompt, /"teardownCmd"/);
  assert.match(prompt, /GLAFKA_TICKET_ID/);
  assert.match(prompt, /"e2e"/);
  assert.match(prompt, /skip it entirely rather than inventing/);
});

test('buildOdysseUpdatePrompt lists only the changed paths and says not to re-scan', () => {
  const prompt = buildOdysseUpdatePrompt({
    changedPaths: ['src/commands/ergon.js', 'test/commands/ergon.test.js'],
    tree: 'src/\n  commands/',
    repoRoot: '/repo',
  });

  assert.match(prompt, /src\/commands\/ergon\.js/);
  assert.match(prompt, /test\/commands\/ergon\.test\.js/);
  assert.match(prompt, /Don't re-scan the rest/);
  assert.match(prompt, /\/repo\/docs\/glafka\/architecture/);
});

test('buildOdysseUpdatePrompt handles an empty change list without a blank block', () => {
  const prompt = buildOdysseUpdatePrompt({ changedPaths: [], tree: 'x', repoRoot: '/repo' });

  assert.match(prompt, /no files changed/);
});

test('both prompts are plain text with no agent-specific tool references', () => {
  const full = buildOdysseFullPrompt({ tree: 'x', repoRoot: '/repo' });
  const update = buildOdysseUpdatePrompt({ changedPaths: ['a.js'], tree: 'x', repoRoot: '/repo' });

  for (const prompt of [full, update]) {
    assert.doesNotMatch(prompt, /superpowers/i);
    assert.doesNotMatch(prompt, /\bSkill\b/);
    assert.doesNotMatch(prompt, /Claude/i);
  }
});

// The scan already reads every file, so it can seed the ethos right away. It is given one command per
// category, with that category's own hint, so it knows which rule belongs where.
test('buildOdysseFullPrompt asks the scan to seed the ethos, per category', () => {
  const prompt = buildOdysseFullPrompt({
    tree: 'src/',
    repoRoot: '/repo',
    categories: [
      { name: 'DOMAIN', hint: 'our billing rules' },
      { name: 'OPS', hint: 'deploys and runbooks' },
    ],
  });

  assert.match(prompt, /what conventions does this codebase already follow/);
  assert.match(prompt, /glafka odysse --propose --domain\s+"<rule>"\s+# our billing rules/);
  assert.match(prompt, /glafka odysse --propose --ops\s+"<rule>"\s+# deploys and runbooks/);
});

// An observation is a guess. It must not land anywhere that reads as a rule a person already agreed
// to. The prompt used to say which headings to avoid; now the command owns the files, so the agent is told to keep out of them entirely — which is the stronger version of the same rule.
test('it keeps observations out of the decided sections', () => {
  const prompt = buildOdysseFullPrompt({
    tree: 'src/',
    repoRoot: '/repo',
    categories: [{ name: 'DOMAIN', hint: 'billing' }],
  });
  const flat = prompt.replace(/\s+/g, ' ');

  assert.match(flat, /Do not edit any file under `docs\/glafka\/ethos\/` yourself/);
  assert.match(flat, /keeps decided rules safe/);
  assert.match(flat, /rules a human has already ruled on are never touched/);
  assert.match(flat, /A human rules on these before any of them take effect/);
});

// A padded list wastes the human's time rejecting made-up rules.
test('it tells the scan that reporting nothing is a correct answer', () => {
  const prompt = buildOdysseFullPrompt({
    tree: 'src/',
    repoRoot: '/repo',
    categories: [{ name: 'DOMAIN', hint: 'billing' }],
  });
  const flat = prompt.replace(/\s+/g, ' ');

  assert.match(flat, /run no command for it. Reporting nothing is a correct answer/);
  assert.match(flat, /Two files agreeing is a coincidence; every file agreeing is a convention/);
  assert.match(flat, /do not invent one to fill a category/);
});

test('with no categories the ethos block is omitted entirely, not left empty', () => {
  const prompt = buildOdysseFullPrompt({ tree: 'src/', repoRoot: '/repo' });

  assert.doesNotMatch(prompt, /--propose/);
  assert.doesNotMatch(prompt, /conventions does this codebase already follow/);
  // Architecture and isolation still work the same as before.
  assert.match(prompt, /docs\/glafka\/architecture\//);
  assert.match(prompt, /isolation\.json/);
});

// The scan agent used to be told to edit docs/glafka/ethos/*.md itself. That was the one write path
// guardrails could not cover, so the prompt now names a command instead. If the file paths come back, so does the hole.
test('the full-scan prompt tells the agent to run the command, not to edit the ethos files', () => {
  const prompt = buildOdysseFullPrompt({
    tree: 'src/',
    repoRoot: '/repo',
    categories: DEFAULT_CATEGORIES,
  });

  assert.match(prompt, /glafka odysse --propose --code/);
  assert.match(prompt, /Do not edit any file\s+under `docs\/glafka\/ethos\/` yourself/);
  assert.equal(
    /docs\/glafka\/ethos\/ETHOS_\w+\.md/.test(prompt),
    false,
    'naming the ethos files invites the agent to write them directly',
  );
});
