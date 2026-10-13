import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  redactEnvValues,
  isSecretName,
  buildEnv,
} from '../../installKit/guardrails/layers/secrets.js';
import { loadLevel } from '../../installKit/guardrails/resolve.js';

// The audit log must keep file paths. If we redact them too,
// the log becomes useless.
test('the audit log keeps its file paths', () => {
  const patterns = loadLevel(2).audit.redactEnvMatching;
  const env = { PWD: '/Users/me/Dev/glafka', OLDPWD: '/Users/me/Dev', HOME: '/Users/me' };
  const line = JSON.stringify({
    op: 'write',
    filePath: '/Users/me/Dev/glafka/src/orders/total.ts',
  });

  assert.equal(redactEnvValues(line, env, patterns), line);
});

test('SSH_AUTH_SOCK is a socket path, not a credential', () => {
  const patterns = loadLevel(2).audit.redactEnvMatching;
  const env = { SSH_AUTH_SOCK: '/private/tmp/com.apple.launchd.abc/Listeners' };
  const line = 'connecting via /private/tmp/com.apple.launchd.abc/Listeners';

  assert.equal(redactEnvValues(line, env, patterns), line);
});

test('a real secret is still redacted from the audit log', () => {
  const patterns = loadLevel(2).audit.redactEnvMatching;
  const env = { GITHUB_TOKEN: 'ghp_thisisatokenvalue', DB_PASSWORD: 'hunter2hunter2' };
  const line = 'ghp_thisisatokenvalue / hunter2hunter2';

  const redacted = redactEnvValues(line, env, patterns);
  assert.doesNotMatch(redacted, /ghp_thisisatokenvalue/);
  assert.doesNotMatch(redacted, /hunter2hunter2/);
});

// This used to be a hardcoded list of three Anthropic names, so a key for
// any other vendor was handed to docker as K=V, in plain sight of `ps`.
test('isSecretName covers every vendor by shape, not by a list of names', () => {
  for (const name of [
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'OPENAI_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'MOONSHOT_API_KEY',
    'OPENROUTER_API_KEY',
    'AWS_SECRET_ACCESS_KEY',
    'DATABASE_URL',
    'GITHUB_TOKEN',
    'NPM_PASSWORD',
  ]) {
    assert.equal(isSecretName(name), true, `${name} must be passed by name only`);
  }
});

// docker needs the real values of these, and none of them is a secret.
test('isSecretName leaves the plumbing variables alone', () => {
  for (const name of [
    'PATH',
    'HOME',
    'TMPDIR',
    'PWD',
    'TERM',
    'LANG',
    'NODE_ENV',
    'CI',
    'GLAFKA_TICKET_ID',
    'GLAFKA_PORT',
    'GLAFKA_PROMPT_FILE',
    'CLAUDE_CONFIG_DIR',
  ]) {
    assert.equal(isSecretName(name), false, `${name} must keep its value`);
  }
});

// glafka installs into six agents, but keepEnv shipped Anthropic-only, so
// five of them had their credential dropped and could never sign in.
for (const level of [2, 3, 4]) {
  test(`level ${level}: keepEnv carries a credential for every supported agent`, () => {
    const keep = loadLevel(level).secrets.keepEnv;
    for (const name of [
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'GEMINI_API_KEY',
      'MOONSHOT_API_KEY',
      'CURSOR_API_KEY',
      'GITHUB_TOKEN',
    ]) {
      assert.ok(keep.includes(name), `${name} must survive buildEnv`);
    }
  });
}

// Dropping it silently is what made this hard to see: the agent just failed
// to sign in, with an error that never named the cause.
test('buildEnv names the credentials it dropped, and points at keepEnv', () => {
  const { env, warnings } = buildEnv(loadLevel(2), {
    PATH: '/usr/bin',
    SOME_VENDOR_API_KEY: 'secret-value',
  });
  assert.equal('SOME_VENDOR_API_KEY' in env, false);
  const warning = warnings.find((w) => w.includes('SOME_VENDOR_API_KEY'));
  assert.ok(warning, 'a dropped credential must be named');
  assert.match(warning!, /secrets\.keepEnv/);
});

// An ordinary variable is dropped all the time. Warning on those would bury
// the one line that matters.
test('buildEnv stays quiet about dropped variables that are not credentials', () => {
  const { warnings } = buildEnv(loadLevel(2), { PATH: '/usr/bin', EDITOR: 'vim' });
  assert.equal(
    warnings.some((w) => w.includes('EDITOR')),
    false,
  );
});

// GH_TOKEN is read only by the `gh` CLI, which is on exec.never at every level, so no
// agent needs it and nothing in glafka's own flow reads it — every GitHub call glafka makes runs on the host. GITHUB_TOKEN deliberately STAYS: it is GitHub Copilot's sign-in credential, and glafka installs a Copilot hook. Dropping it would break that agent. buildEnv already warns about it, because it matches SECRET_SHAPED.
for (const level of [2, 3, 4]) {
  test(`level ${level}: GH_TOKEN is not handed to the agent`, () => {
    const keep = loadLevel(level).secrets.keepEnv;
    assert.equal(keep.includes('GH_TOKEN'), false, 'nothing needs GH_TOKEN');
    assert.ok(keep.includes('GITHUB_TOKEN'), "Copilot's credential must survive");
  });
}

test('keeping a credential-shaped variable is warned about, every run', () => {
  const { warnings } = buildEnv(loadLevel(2), { PATH: '/usr/bin', GITHUB_TOKEN: 'ghp_REAL' });
  assert.ok(
    warnings.some((w) => w.includes('GITHUB_TOKEN')),
    'the shipped default must announce itself',
  );
});
