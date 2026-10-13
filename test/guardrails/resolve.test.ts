import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { scopesFor, applyOverride, loadLevel } from '../../installKit/guardrails/resolve.js';
import { check } from '../../installKit/guardrails/layers/exec.js';

// Old bug: the scratch folder path was rebuilt wrong from inside
// the sandbox. A separate env var now carries the correct path.
test('scopesFor prefers GLAFKA_TICKET_SCRATCH over re-deriving from TMPDIR', () => {
  const previous = {
    TMPDIR: process.env.TMPDIR,
    GLAFKA_TICKET_SCRATCH: process.env.GLAFKA_TICKET_SCRATCH,
  };
  try {
    process.env.TMPDIR = '/tmp/glafka-2026-08-02-scratch-from-the-env';
    process.env.GLAFKA_TICKET_SCRATCH = '/tmp/glafka-2026-08-02-scratch-from-the-env';

    const scopes = scopesFor({ repoRoot: '/repo', ticketId: '2026-08-02-scratch-from-the-env' });

    assert.equal(scopes.TICKET_SCRATCH, '/tmp/glafka-2026-08-02-scratch-from-the-env');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('scopesFor falls back to deriving from TMPDIR when GLAFKA_TICKET_SCRATCH is unset', () => {
  const previous = {
    TMPDIR: process.env.TMPDIR,
    GLAFKA_TICKET_SCRATCH: process.env.GLAFKA_TICKET_SCRATCH,
  };
  try {
    process.env.TMPDIR = '/tmp';
    delete process.env.GLAFKA_TICKET_SCRATCH;

    const scopes = scopesFor({
      repoRoot: '/repo',
      ticketId: '2026-08-02-scratch-derived-from-tmpdir',
    });

    assert.equal(
      scopes.TICKET_SCRATCH,
      path.join('/tmp', 'glafka-2026-08-02-scratch-derived-from-tmpdir'),
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

// --------------------------------------------------------------------------- Tests for a bug: a
// setting could look "applied" but change nothing. ---------------------------------------------------------------------------

// Check that env vars can be narrowed down to just PATH.
test('narrowing secrets.keepEnv really narrows it', () => {
  const base = loadLevel(4);
  const { policy, rejected } = applyOverride(base, { secrets: { keepEnv: ['PATH'] } });

  assert.deepEqual(rejected, []);
  assert.deepEqual(policy.secrets.keepEnv, ['PATH']);
  assert.ok(
    !policy.secrets.keepEnv.includes('ANTHROPIC_API_KEY'),
    'the project asked for the API key to be out of the room',
  );
});

// Check that allowed commands can be narrowed to just git.
test('narrowing exec.allow really narrows it', () => {
  const base = loadLevel(3);
  const { policy, rejected } = applyOverride(base, {
    exec: { allow: [{ cmd: 'git', subcommands: ['status'] }] },
  });

  assert.deepEqual(rejected, []);
  assert.deepEqual(
    policy.exec.allow.map((r) => r.cmd),
    ['git'],
  );
  assert.equal(policy.exec.allow[0].subcommands?.length, 1);
});

// A new rule for the same command should replace the old one,
// not just sit alongside it unused.
test('widening an existing exec.allow entry actually takes effect', () => {
  const base = loadLevel(3);
  const { policy, widened } = applyOverride(base, {
    exec: { allow: [{ cmd: 'git', anyArgs: true }] },
  });

  const gitRules = policy.exec.allow.filter((r) => r.cmd === 'git');
  assert.equal(gitRules.length, 1, 'one rule per command, or the second one is unreachable');
  assert.equal(gitRules[0].anyArgs, true);
  assert.deepEqual(widened, ['exec.allow']);
  // `tag` is off level 3's git subcommand list, so it only passes if the widening really took effect.
  // It used to be `worktree list` — that is now denied whatever the allow list says, which is the test below.
  assert.equal(check(policy, { op: 'exec', argv: ['git', 'tag', '-l'] }).allow, true);
});

// The subcommands that name their source or destination as a bare argument reach
// outside filesystem.allowRoots, which is neverOverridable. So the guard against them has to be a floor the allow list cannot lift — the same standing exec.never has — not a rule a widened `git` can undo.
test('widening git to anyArgs does NOT lift the escape-subcommand guard', () => {
  const { policy } = applyOverride(loadLevel(3), {
    exec: { allow: [{ cmd: 'git', anyArgs: true }] },
  });

  for (const argv of [
    ['git', 'clone', '.', '/Users/victim/pwned'],
    ['git', 'init', '/Users/victim/pwned'],
    ['git', 'worktree', 'add', '/Users/victim/pwned', 'HEAD'],
    ['git', 'checkout-index', '--prefix=/Users/victim/pwned/', '-a'],
    ['git', 'archive', '-o', '/Users/victim/pwned.tar', 'HEAD'],
    ['git', 'bundle', 'create', '/Users/victim/x.bundle', 'HEAD'],
    // Flags before the subcommand must not hide it.
    ['git', '--no-pager', 'clone', '.', '/Users/victim/pwned'],
  ]) {
    assert.equal(check(policy, { op: 'exec', argv }).allow, false, argv.join(' '));
  }

  // The other half: ordinary work must not be caught by it. A commit message
  // that happens to say "clone" is not a clone.
  for (const argv of [
    ['git', 'status'],
    ['git', 'add', '-A'],
    ['git', 'commit', '-m', 'clone the config helper'],
    ['git', 'commit', '-m', 'archive'],
    ['git', 'rebase', 'main'],
  ]) {
    assert.equal(check(policy, { op: 'exec', argv }).allow, true, argv.join(' '));
  }
});

// A change that does nothing should not be logged as a real change.
// That would ask a human to approve something fake.
test('an override that changes nothing is rejected with a reason, not reported as applied', () => {
  const base = loadLevel(3);
  const { widened, rejected } = applyOverride(base, {
    // Exactly what the level already says.
    exec: { allow: base.exec.allow },
  });
  assert.deepEqual(widened, []);
  assert.deepEqual(rejected, [
    { path: 'exec.allow', why: 'no effect — it already matches the level default' },
  ]);
});

// Adding to a "deny" list should always make it stricter.
test('deny-style lists still merge by union', () => {
  const base = loadLevel(2);
  const { policy } = applyOverride(base, { filesystem: { denyWithin: ['secrets/**'] } });
  assert.ok(policy.filesystem.denyWithin.includes('secrets/**'));
  assert.ok(policy.filesystem.denyWithin.includes('.git/config'), 'and keep what was there');
});

// Two rules for the same command should never be silently allowed.
test('exec.check refuses to run against a policy with duplicate cmd entries', () => {
  const base = loadLevel(3);
  const broken = {
    ...base,
    exec: { ...base.exec, allow: [...base.exec.allow, { cmd: 'git', anyArgs: true }] },
  };
  const result = check(broken, { op: 'exec', argv: ['git', 'status'] });
  assert.equal(result.allow, false);
  assert.match(result.reason, /more than one rule/);
});
