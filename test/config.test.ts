import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDir } from './helpers/tempDir.js';
import {
  loadConfig,
  resolveBaseRef,
  assertBaseRefExists,
  resolveChecksCmd,
  resolveE2eCmd,
  resolveAgentCmd,
} from '../src/config.js';
import { makeGitRepo, addBareRemote } from './helpers/gitFixture.js';

function tempRepoRoot() {
  return makeTempDir('config');
}

test('loadConfig returns defaults when no .glafka.json exists', { concurrency: true }, () => {
  const repoRoot = tempRepoRoot();

  assert.deepEqual(loadConfig(repoRoot), {
    // null means unset, not the same as a real branch name.
    baseRef: null,
    checksCmd: null,
    e2eCmd: null,
    portRange: { start: 4100, end: 4199 },
    ergonTimeoutMs: 60 * 60 * 1000,
    checksTimeoutMs: 10 * 60 * 1000,
    e2eTimeoutMs: 10 * 60 * 1000,
    bootstrapTimeoutMs: 15 * 60 * 1000,
    isolationHookTimeoutMs: 5 * 60 * 1000,
    agents: {},
    maxReviewRounds: 3,
    notifyCmd: null,
    reviewDoc: null,
    observability: { enabled: true },
  });
});

// Old bug: setup/teardown commands had no time limit.
// A stuck one could hang forever.
test(
  'isolationHookTimeoutMs is validated like the other timeout budgets',
  { concurrency: true },
  () => {
    const repoRoot = tempRepoRoot();
    fs.writeFileSync(
      path.join(repoRoot, '.glafka.json'),
      JSON.stringify({ isolationHookTimeoutMs: 0 }),
    );

    assert.throws(() => loadConfig(repoRoot), /isolationHookTimeoutMs/);
  },
);

test('loadConfig merges a partial .glafka.json over the defaults', { concurrency: true }, () => {
  const repoRoot = tempRepoRoot();
  fs.writeFileSync(
    path.join(repoRoot, '.glafka.json'),
    JSON.stringify({ baseRef: 'develop', checksCmd: 'make check' }),
  );

  const config = loadConfig(repoRoot);

  assert.equal(config.baseRef, 'develop');
  assert.equal(config.checksCmd, 'make check');
  assert.equal(config.e2eCmd, null);
  assert.deepEqual(config.portRange, { start: 4100, end: 4199 });
});

test(
  'loadConfig merges a partial portRange instead of replacing it wholesale',
  { concurrency: true },
  () => {
    const repoRoot = tempRepoRoot();
    fs.writeFileSync(
      path.join(repoRoot, '.glafka.json'),
      JSON.stringify({ portRange: { start: 3000 } }),
    );

    assert.deepEqual(loadConfig(repoRoot).portRange, { start: 3000, end: 4199 });
  },
);

test('loadConfig rejects a portRange whose end is before its start', { concurrency: true }, () => {
  const repoRoot = tempRepoRoot();
  fs.writeFileSync(
    path.join(repoRoot, '.glafka.json'),
    JSON.stringify({ portRange: { start: 5000 } }),
  );

  // The default end value is now smaller than the new start.
  // This bad range should be caught.
  assert.throws(() => loadConfig(repoRoot), /portRange\.end.*before.*portRange\.start/);
});

test(
  'resolveBaseRef prefers an explicit .glafka.json over everything the repo says',
  { concurrency: true },
  () => {
    const repoRoot = makeGitRepo({ branch: 'master' });

    const baseRef = resolveBaseRef({
      repoRoot,
      config: { baseRef: 'develop' },
      profile: { workspace: { baseRef: 'master' } },
    });

    assert.equal(baseRef, 'develop');
  },
);

test(
  'resolveBaseRef falls back to the discovered workspace profile when config is silent',
  { concurrency: true },
  () => {
    const repoRoot = makeGitRepo({ branch: 'master' });

    const baseRef = resolveBaseRef({
      repoRoot,
      config: { baseRef: null },
      profile: { workspace: { baseRef: 'release' } },
    });

    assert.equal(baseRef, 'release');
  },
);

test(
  "resolveBaseRef detects the repo's own default branch when nothing is configured",
  { concurrency: true },
  () => {
    // Without this, the wrong default branch name would be used.
    const repoRoot = makeGitRepo({ branch: 'master' });

    assert.equal(resolveBaseRef({ repoRoot, config: { baseRef: null }, profile: null }), 'master');
  },
);

test('resolveBaseRef reads origin/HEAD ahead of guessing', { concurrency: true }, () => {
  const repoRoot = makeGitRepo({ branch: 'trunk' });
  addBareRemote(repoRoot, { branch: 'trunk' });

  assert.equal(resolveBaseRef({ repoRoot, config: {}, profile: null }), 'trunk');
});

test(
  'assertBaseRefExists names the field and file instead of leaking a raw git error',
  { concurrency: true },
  () => {
    const repoRoot = makeGitRepo({ branch: 'master' });

    assert.doesNotThrow(() => assertBaseRefExists(repoRoot, 'master'));
    assert.throws(() => assertBaseRefExists(repoRoot, 'main'), /baseRef "main".*\.glafka\.json/s);
  },
);

// --------------------------------------------------------------------------- A value you set
// yourself always wins over a guessed one. ---------------------------------------------------------------------------

test(
  'resolveChecksCmd prefers an explicit .glafka.json value over the discovered one',
  { concurrency: true },
  () => {
    const resolved = resolveChecksCmd({
      config: { checksCmd: 'make check' },
      profile: { workspace: { checksCmd: 'pnpm -r test' } },
    });

    assert.equal(resolved, 'make check');
  },
);

test(
  'resolveChecksCmd falls back to what odysse discovered and a human approved',
  { concurrency: true },
  () => {
    const resolved = resolveChecksCmd({
      config: { checksCmd: null },
      profile: { workspace: { checksCmd: 'uv run pytest && uv run mypy .' } },
    });

    assert.equal(resolved, 'uv run pytest && uv run mypy .');
  },
);

// Returns null instead of guessing. That gets recorded as UNKNOWN, not passed.
test(
  'resolveChecksCmd returns null when nothing has answered, rather than inventing one',
  { concurrency: true },
  () => {
    assert.equal(resolveChecksCmd({ config: {}, profile: null }), null);
    assert.equal(resolveChecksCmd({ config: {}, profile: { workspace: {} } }), null);
  },
);

test(
  'resolveE2eCmd follows the same precedence, independently of checksCmd',
  { concurrency: true },
  () => {
    assert.equal(
      resolveE2eCmd({
        config: { e2eCmd: 'playwright test' },
        profile: { workspace: { e2eCmd: 'x' } },
      }),
      'playwright test',
    );
    assert.equal(
      resolveE2eCmd({ config: {}, profile: { workspace: { e2eCmd: 'cypress run' } } }),
      'cypress run',
    );
    assert.equal(resolveE2eCmd({ config: {}, profile: null }), null);
  },
);

// --------------------------------------------------------------------------- Tests for agent
// commands. Any shell command works, no code changes needed. ---------------------------------------------------------------------------

test('loadConfig defaults agents to an empty object', { concurrency: true }, () => {
  const repoRoot = tempRepoRoot();
  assert.deepEqual(loadConfig(repoRoot).agents, {});
});

test("loadConfig reads a project's own per-role agent commands", { concurrency: true }, () => {
  const repoRoot = tempRepoRoot();
  fs.writeFileSync(
    path.join(repoRoot, '.glafka.json'),
    JSON.stringify({ agents: { coder: 'claude -p', reviewer: 'gemini -p' } }),
  );

  assert.deepEqual(loadConfig(repoRoot).agents, { coder: 'claude -p', reviewer: 'gemini -p' });
});

test(
  'loadConfig refuses a non-object agents field, naming it by name',
  { concurrency: true },
  () => {
    const repoRoot = tempRepoRoot();
    fs.writeFileSync(path.join(repoRoot, '.glafka.json'), JSON.stringify({ agents: 'claude -p' }));

    // This is the library's own error message, not one we wrote.
    assert.throws(() => loadConfig(repoRoot), /"agents".*expected record/);
  },
);

test('loadConfig refuses an empty-string agent command', { concurrency: true }, () => {
  const repoRoot = tempRepoRoot();
  fs.writeFileSync(path.join(repoRoot, '.glafka.json'), JSON.stringify({ agents: { coder: '' } }));

  // This is the library's own error message, not one we wrote.
  assert.throws(() => loadConfig(repoRoot), /"agents\.coder".*string to have/);
});

test(
  "resolveAgentCmd prefers the role's own command over agents.default",
  { concurrency: true },
  () => {
    const resolved = resolveAgentCmd({
      config: { agents: { reviewer: 'gemini -p', default: 'claude -p' } },
      role: 'reviewer',
    });

    assert.equal(resolved, 'gemini -p');
  },
);

test(
  'resolveAgentCmd falls back to agents.default for a role with no command of its own',
  { concurrency: true },
  () => {
    const resolved = resolveAgentCmd({
      config: { agents: { default: 'claude -p' } },
      role: 'reporter',
    });

    assert.equal(resolved, 'claude -p');
  },
);

test(
  'resolveAgentCmd falls back to GLAFKA_AGENT_CMD when nothing is configured',
  { concurrency: true },
  () => {
    const previous = process.env.GLAFKA_AGENT_CMD;
    process.env.GLAFKA_AGENT_CMD = 'claude -p';
    try {
      assert.equal(resolveAgentCmd({ config: {}, role: 'reviewer' }), 'claude -p');
    } finally {
      if (previous === undefined) delete process.env.GLAFKA_AGENT_CMD;
      else process.env.GLAFKA_AGENT_CMD = previous;
    }
  },
);

// Returns null instead of guessing a command.
test(
  'resolveAgentCmd returns null when nothing at all is configured',
  { concurrency: true },
  () => {
    const previous = process.env.GLAFKA_AGENT_CMD;
    delete process.env.GLAFKA_AGENT_CMD;
    try {
      assert.equal(resolveAgentCmd({ config: {}, role: 'reviewer' }), null);
    } finally {
      if (previous !== undefined) process.env.GLAFKA_AGENT_CMD = previous;
    }
  },
);

// --------------------------------------------------------------------------- Settings that limit
// auto-fix retries and send notifications. ---------------------------------------------------------------------------

test(
  "loadConfig reads a project's own maxReviewRounds and notifyCmd",
  { concurrency: true },
  () => {
    const repoRoot = tempRepoRoot();
    fs.writeFileSync(
      path.join(repoRoot, '.glafka.json'),
      JSON.stringify({
        maxReviewRounds: 5,
        notifyCmd: 'osascript -e \'display notification "x"\'',
      }),
    );

    const config = loadConfig(repoRoot);
    assert.equal(config.maxReviewRounds, 5);
    assert.match(config.notifyCmd!, /osascript/);
  },
);

test('loadConfig refuses a non-positive-integer maxReviewRounds', { concurrency: true }, () => {
  const repoRoot = tempRepoRoot();
  fs.writeFileSync(path.join(repoRoot, '.glafka.json'), JSON.stringify({ maxReviewRounds: 0 }));

  // This is the library's own error message, not one we wrote.
  assert.throws(() => loadConfig(repoRoot), /"maxReviewRounds".*expected number to be >0/);
});

test('loadConfig refuses a non-string, non-null notifyCmd', { concurrency: true }, () => {
  const repoRoot = tempRepoRoot();
  fs.writeFileSync(path.join(repoRoot, '.glafka.json'), JSON.stringify({ notifyCmd: 42 }));

  // This is the library's own error message, not one we wrote.
  assert.throws(() => loadConfig(repoRoot), /"notifyCmd".*expected string/);
});

test('observability is on when the config says nothing', () => {
  const repoRoot = makeTempDir('cfg-obs');

  assert.equal(loadConfig(repoRoot).observability.enabled, true);
});

test('observability can be turned off explicitly', () => {
  const repoRoot = makeTempDir('cfg-obs');
  fs.writeFileSync(
    path.join(repoRoot, '.glafka.json'),
    JSON.stringify({ observability: { enabled: false } }),
  );

  assert.equal(loadConfig(repoRoot).observability.enabled, false);
});

// portRange needs a nested merge for this reason; so does this.
test('a partial observability object keeps its defaults', () => {
  const repoRoot = makeTempDir('cfg-obs');
  fs.writeFileSync(path.join(repoRoot, '.glafka.json'), JSON.stringify({ observability: {} }));

  assert.equal(loadConfig(repoRoot).observability.enabled, true);
});
