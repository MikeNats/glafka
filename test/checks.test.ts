import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runChecks, checksVerdict, explainNoChecks, CHECK_VERDICT } from '../src/checks.js';
import { makeTempDir } from './helpers/tempDir.js';

// A fake error, shaped like what a real failed command gives us.
interface FakeExecError extends Error {
  code?: string;
  killed?: boolean;
  stdout?: string;
  stderr?: string;
}

function fakeExecError(message: string, extra: Partial<FakeExecError> = {}): FakeExecError {
  return Object.assign(new Error(message), extra);
}

function tempProjectDir(scripts: Record<string, string>) {
  const dir = makeTempDir('checks');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts }));
  return dir;
}

// Three verdicts. Empty list is the key case.

test('no checks at all is UNKNOWN, not a pass', () => {
  assert.equal(checksVerdict([]), CHECK_VERDICT.UNKNOWN);
});

test('every check passing is PASSED', () => {
  assert.equal(
    checksVerdict([
      { name: 'lint', passed: true, output: '' },
      { name: 'test', passed: true, output: '' },
    ]),
    CHECK_VERDICT.PASSED,
  );
});

test('one failing check among passing ones is FAILED', () => {
  assert.equal(
    checksVerdict([
      { name: 'lint', passed: true, output: '' },
      { name: 'test', passed: false, output: '1 failing' },
    ]),
    CHECK_VERDICT.FAILED,
  );
});

// Explains why UNKNOWN is not a pass.

// Do not guess the tech stack. Always suggest odysse --checks.
test('the explanation always points at odysse --checks as the fix', () => {
  const why = explainNoChecks(tempProjectDir({ build: 'tsc' }));

  assert.match(why, /odysse --checks/);
  assert.match(why, /nothing is proven/);
});

test('a Node project is told the convenience path is Node-only', () => {
  const why = explainNoChecks(tempProjectDir({ build: 'tsc' }));

  assert.match(why, /Node-only/);
  assert.match(why, /lint\/typecheck\/test/);
});

// For non-Node projects, say there is no fallback, not "no checks found".
test('a non-Node project is told glafka has nothing to fall back on, not that it has no checks', () => {
  const dir = makeTempDir('checks');
  fs.writeFileSync(path.join(dir, 'pyproject.toml'), "[project]\nname = 'x'\n");

  const why = explainNoChecks(dir);

  assert.match(why, /not a single-package Node project/);
  assert.match(why, /nothing to fall back on/);
  assert.match(why, /odysse --checks/);
});

// Never guess a command just because we see a known file.
test('no ecosystem is ever named and no command is ever guessed', () => {
  const dir = makeTempDir('checks');
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ workspaces: ['packages/*'], scripts: {} }),
  );
  fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
  fs.writeFileSync(path.join(dir, 'Cargo.toml'), "[package]\nname = 'x'\n");

  const why = explainNoChecks(dir);

  for (const guess of [/pnpm -r/, /npm test --workspaces/, /cargo test/, /turbo run/, /monorepo/]) {
    assert.doesNotMatch(why, guess);
  }
});

test("runChecks returns an empty list when there's no package.json", async () => {
  const dir = makeTempDir('checks');
  assert.deepEqual(await runChecks(dir), []);
});

test('runChecks only runs scripts the project actually defines', async () => {
  const dir = tempProjectDir({ test: 'echo testing' });
  const calls: string[] = [];
  const fakeRun = (cmd: string, args: string[]) => {
    calls.push(args[2]);
    return 'ok\n';
  };

  const results = await runChecks(dir, { run: fakeRun });

  assert.deepEqual(calls, ['test']);
  assert.deepEqual(results, [{ name: 'test', passed: true, output: 'ok\n' }]);
});

// Glafka used to run package.json's own scripts on the host, unattended, before the
// hostExec warning about that exact file even existed. When this branch's diff touched package.json, the npm fallback must refuse instead of running scripts nobody has reviewed.
test('runChecks refuses the npm fallback when package.json itself is untrusted', async () => {
  const dir = tempProjectDir({ test: 'echo testing' });
  let ran = false;
  const fakeRun = () => {
    ran = true;
    return 'ok\n';
  };

  const results = await runChecks(dir, { run: fakeRun, untrustedPackageJson: true });

  assert.equal(ran, false, 'the npm fallback must never actually run');
  assert.equal(results.length, 1);
  assert.equal(results[0].name, 'package.json');
  assert.equal(results[0].passed, false);
  assert.equal(results[0].unknown, true);
  assert.match(results[0].output, /not run automatically/);
});

// A configured checksCmd is explicit and reviewed by a human ahead of time, so it is trusted
// regardless — only the zero-config npm fallback is the risk.
test('runChecks still honors an explicit checksCmd even when package.json is untrusted', async () => {
  const dir = tempProjectDir({ test: 'echo testing' });
  const calls: string[] = [];
  const fakeRun = (cmd: string, args: string[]) => {
    calls.push(args.join(' '));
    return 'ok\n';
  };

  const results = await runChecks(dir, {
    run: fakeRun,
    checksCmd: 'make check',
    untrustedPackageJson: true,
  });

  assert.deepEqual(calls, ['-c make check']);
  assert.equal(results[0].passed, true);
});

test('runChecks runs lint, typecheck, and test in that order when all are defined', async () => {
  const dir = tempProjectDir({
    test: 't',
    lint: 'l',
    typecheck: 'tc',
  });
  const calls: string[] = [];
  const fakeRun = (cmd: string, args: string[]) => {
    calls.push(args[2]);
    return 'ok\n';
  };

  await runChecks(dir, { run: fakeRun });

  assert.deepEqual(calls, ['lint', 'typecheck', 'test']);
});

test('runChecks captures failure output instead of throwing', async () => {
  const dir = tempProjectDir({ lint: 'eslint .' });
  const fakeRun = () => {
    throw fakeExecError('Command failed', { stdout: '3 problems found\n', stderr: '' });
  };

  const results = await runChecks(dir, { run: fakeRun });

  assert.equal(results.length, 1);
  assert.equal(results[0]!.name, 'lint');
  assert.equal(results[0]!.passed, false);
  assert.match(results[0]!.output, /3 problems found/);
  // A failing fallback check says it was a guess, not the project's own command — otherwise the coder
  // is sent back to fix a script that was already failing on the base branch.
  assert.match(results[0]!.output, /this check was not configured/);
  assert.match(results[0]!.output, /"checksCmd" in \.glafka\.json/);
});

test('a configured checksCmd fully replaces lint/typecheck/test auto-detection', async () => {
  const dir = tempProjectDir({ test: 't', lint: 'l', typecheck: 'tc' });
  const calls: { cmd: string; args: string[] }[] = [];
  const fakeRun = (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    return 'ok\n';
  };

  const results = await runChecks(dir, { run: fakeRun, checksCmd: 'make check' });

  assert.deepEqual(calls, [{ cmd: 'sh', args: ['-c', 'make check'] }]);
  assert.deepEqual(results, [{ name: 'checks', passed: true, output: 'ok\n' }]);
});

test('a configured e2eCmd always runs, in addition to whatever else ran', async () => {
  const dir = tempProjectDir({ test: 't' });
  const calls: string[] = [];
  const fakeRun = (cmd: string, args: string[]) => {
    calls.push(args[args.length - 1]);
    return 'ok\n';
  };

  const results = await runChecks(dir, { run: fakeRun, e2eCmd: 'playwright test' });

  assert.deepEqual(calls, ['test', 'playwright test']);
  assert.deepEqual(
    results.map((r) => r.name),
    ['test', 'e2e'],
  );
});

test('a check that times out is reported as failed, not left hanging', async () => {
  const dir = tempProjectDir({ test: 't' });
  const fakeRun = () => {
    throw fakeExecError('spawnSync npm ETIMEDOUT', { code: 'ETIMEDOUT' });
  };

  const results = await runChecks(dir, { run: fakeRun, checksTimeoutMs: 5000 });

  assert.equal(results.length, 1);
  assert.equal(results[0]!.name, 'test');
  assert.equal(results[0]!.passed, false);
  assert.match(results[0]!.output, /timed out after 5000ms/);
});

test("runChecks passes the configured timeout through to run()'s options", async () => {
  const dir = tempProjectDir({ test: 't' });
  let receivedOptions: { timeout?: number | null } | null = null;
  const fakeRun = (cmd: string, args: string[], options: { timeout?: number | null }) => {
    receivedOptions = options;
    return 'ok\n';
  };

  await runChecks(dir, { run: fakeRun, checksTimeoutMs: 12345 });

  assert.equal(receivedOptions!.timeout, 12345);
});

test('runChecks redacts the value of any secret-shaped env var out of captured output', async () => {
  const dir = tempProjectDir({ test: 't' });
  const varName = 'GLAFKA_TEST_API_KEY';
  const secretValue = 'sk-super-secret-value-12345';
  process.env[varName] = secretValue;
  try {
    const fakeRun = () => `connecting with key ${secretValue}\nok\n`;

    const results = await runChecks(dir, { run: fakeRun });

    assert.doesNotMatch(results[0].output, new RegExp(secretValue));
    assert.match(results[0].output, /connecting with key \[REDACTED\]/);
  } finally {
    delete process.env[varName];
  }
});

test('runChecks redacts secrets from failure output too, not just successful output', async () => {
  const dir = tempProjectDir({ test: 't' });
  const varName = 'GLAFKA_TEST_DB_PASSWORD';
  const secretValue = 'hunter2hunter2';
  process.env[varName] = secretValue;
  try {
    const fakeRun = () => {
      throw fakeExecError('Command failed', {
        stdout: '',
        stderr: `auth failed for password=${secretValue}\n`,
      });
    };

    const results = await runChecks(dir, { run: fakeRun });

    assert.doesNotMatch(results[0].output, new RegExp(secretValue));
  } finally {
    delete process.env[varName];
  }
});

test('runChecks redacts credentials embedded in a URL even with no matching env var name', async () => {
  const dir = tempProjectDir({ test: 't' });
  const fakeRun = () => 'connecting to postgresql://dbuser:dbpass1234@localhost:5432/mydb\n';

  const results = await runChecks(dir, { run: fakeRun });

  assert.doesNotMatch(results[0].output, /dbuser:dbpass1234/);
  assert.match(results[0].output, /postgresql:\/\/\[REDACTED\]@localhost:5432\/mydb/);
});

test('runChecks does not redact short env var values (too easy to false-positive on common substrings)', async () => {
  const dir = tempProjectDir({ test: 't' });
  process.env.GLAFKA_TEST_API_KEY = 'ok'; // too short to redact
  try {
    const fakeRun = () => 'ok\n';
    const results = await runChecks(dir, { run: fakeRun });
    assert.equal(results[0].output, 'ok\n');
  } finally {
    delete process.env.GLAFKA_TEST_API_KEY;
  }
});

// Output that is too big is its own case, not a failure.
// Old code wrongly marked huge output as a failed test.

function maxBufferError(): FakeExecError {
  const err = fakeExecError('stdout maxBuffer length exceeded', {
    code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    stdout: 'lots of passing test output\n',
  });
  // Node leaves this empty, so the timeout check misses it.
  assert.equal(err.killed, undefined);
  return err;
}

test('a check whose output blows past maxBuffer is reported unknown, never as a failure', async () => {
  const dir = tempProjectDir({ test: 't' });
  const results = await runChecks(dir, {
    run: () => Promise.reject(maxBufferError()),
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].unknown, true);
  assert.match(results[0].output, /NOT a failure/);
  // The start of the real output is kept, so we can still see it.
  assert.match(results[0].output, /lots of passing test output/);
});

test('a cut-off check makes the verdict UNKNOWN, not FAILED and not PASSED', async () => {
  const dir = tempProjectDir({ test: 't' });
  const results = await runChecks(dir, {
    run: () => Promise.reject(maxBufferError()),
  });

  assert.equal(checksVerdict(results), CHECK_VERDICT.UNKNOWN);
});

test('a real failure still outranks a cut-off check', () => {
  assert.equal(
    checksVerdict([
      { name: 'lint', passed: false, unknown: true, output: 'cut off' },
      { name: 'test', passed: false, output: '1 failing' },
    ]),
    CHECK_VERDICT.FAILED,
  );
});

test('a cut-off check never collapses into PASSED just because nothing failed', () => {
  assert.equal(
    checksVerdict([
      { name: 'lint', passed: true, output: '' },
      { name: 'test', passed: false, unknown: true, output: 'cut off' },
    ]),
    CHECK_VERDICT.UNKNOWN,
  );
});

test("defaultRun raises maxBuffer past Node's 1MB default", async () => {
  const dir = tempProjectDir({ test: 't' });
  // Uses a real process here, not a fake one.
  const results = await runChecks(dir, {
    checksCmd: `node -e "process.stdout.write('x'.repeat(2 * 1024 * 1024))"`,
  });

  assert.equal(results[0].passed, true);
  assert.equal(results[0].output.length, 2 * 1024 * 1024);
});

// --------------------------------------------------------------------------- Tests for past bug
// fixes. ---------------------------------------------------------------------------

// A broken package.json should be a failed check.
// It should not crash the whole process.
test('an unparseable package.json is a failing check, not an exception', async () => {
  const dir = makeTempDir('checks');
  fs.writeFileSync(path.join(dir, 'package.json'), '{ "scripts": { "test": ');

  const results = await runChecks(dir);
  assert.equal(checksVerdict(results), CHECK_VERDICT.FAILED);
  assert.equal(results.length, 1);
  assert.equal(results[0].name, 'package.json');
  assert.match(results[0].output, /could not be read/);
});

test('a healthy package.json still runs its scripts', async () => {
  const dir = tempProjectDir({ test: 'echo ok' });
  const results = await runChecks(dir, { run: async () => 'ok\n' });
  assert.deepEqual(
    results.map((r) => r.name),
    ['test'],
  );
});

// Old bug: PWD looked like a secret and got redacted.
// This hid the file path of real failing tests.
test('PWD is not treated as a secret, so failing tests keep their file paths', async () => {
  const previous = { ...process.env };
  try {
    process.env.PWD = '/Users/me/Dev/glafka';
    process.env.OLDPWD = '/Users/me/Dev';
    process.env.SSH_AUTH_SOCK = '/private/tmp/com.apple.launchd.abc/Listeners';

    const dir = tempProjectDir({ test: 'jest' });
    const results = await runChecks(dir, {
      run: async () => {
        throw fakeExecError('failed', {
          stdout:
            '    at Object.<anonymous> (/Users/me/Dev/glafka/src/orders/total.test.ts:14:22)\n' +
            '    agent socket /private/tmp/com.apple.launchd.abc/Listeners\n',
        });
      },
    });

    assert.match(results[0].output, /\/Users\/me\/Dev\/glafka\/src\/orders\/total\.test\.ts:14:22/);
    assert.doesNotMatch(results[0].output, /REDACTED/);
  } finally {
    process.env = previous;
  }
});

test('a real secret is still redacted', async () => {
  const previous = { ...process.env };
  try {
    process.env.GITHUB_TOKEN = 'ghp_thisisatokenvalue';
    process.env.MY_PASSWORD = 'hunter2hunter2';

    const dir = tempProjectDir({ test: 'x' });
    const results = await runChecks(dir, {
      run: async () => 'token ghp_thisisatokenvalue and pass hunter2hunter2\n',
    });

    assert.doesNotMatch(results[0].output, /ghp_thisisatokenvalue/);
    assert.doesNotMatch(results[0].output, /hunter2hunter2/);
  } finally {
    process.env = previous;
  }
});

// The guard sat inside the `else if`, which is the one branch skipped whenever the
// recommended configuration is used — an explicit checksCmd. `checksCmd: "npm test"` runs the branch's own committed scripts just the same, on the host, with no cage at any level.
test('a host-executing change blocks the configured checksCmd too, not just the fallback', async () => {
  let ran = false;
  const run = async () => {
    ran = true;
    return 'should not happen';
  };

  const results = await runChecks('/tmp', {
    run,
    checksCmd: 'npm test',
    hostExecutingChanges: ['package.json', 'scripts/build.sh'],
  });

  assert.equal(ran, false, 'the command must not run at all');
  assert.equal(results.length, 1);
  assert.equal(results[0].passed, false);
  assert.equal(results[0].unknown, true, 'NOT a failure and NOT a pass');
  assert.match(results[0].output, /scripts\/build\.sh/);
});

test('an ordinary diff still runs the configured checksCmd', async () => {
  let ran = false;
  const run = async () => {
    ran = true;
    return 'ok';
  };
  const results = await runChecks('/tmp', { run, checksCmd: 'npm test', hostExecutingChanges: [] });
  assert.equal(ran, true);
  assert.equal(results[0].passed, true);
});

// --------------------------------------------------------------------------- The ticket's own env.
// Provisioning writes .env.glafka into the worktree — the reserved ports, and whatever setupCmd
// derived from them (a DATABASE_URL for the ticket's own database). Only the dev-server starter ever
// read it, so a seeded per-ticket database was unreachable from the very tests meant to use it.

function tempWorktreeWithEnv(scripts: Record<string, string>, envFile: string) {
  const dir = tempProjectDir(scripts);
  fs.writeFileSync(path.join(dir, '.env.glafka'), envFile);
  return dir;
}

test('checks run with the ticket env from .env.glafka', async () => {
  const dir = tempWorktreeWithEnv(
    { test: 'echo testing' },
    'DB_PORT=4137\nDATABASE_URL=postgresql://localhost:4137/app\n',
  );
  let seen: Record<string, string | undefined> | undefined;
  const fakeRun = (_cmd: string, _args: string[], options: { env?: NodeJS.ProcessEnv }) => {
    seen = options.env;
    return 'ok\n';
  };

  await runChecks(dir, { run: fakeRun });

  assert.equal(seen!.DATABASE_URL, 'postgresql://localhost:4137/app');
  assert.equal(seen!.DB_PORT, '4137');
});

// e2e is the one that actually needs it — it talks to the ticket's database.
test('the e2e command gets the ticket env too', async () => {
  const dir = tempWorktreeWithEnv({}, 'DATABASE_URL=postgresql://localhost:4137/app\n');
  const seen: (string | undefined)[] = [];
  const fakeRun = (_cmd: string, _args: string[], options: { env?: NodeJS.ProcessEnv }) => {
    seen.push(options.env?.DATABASE_URL);
    return 'ok\n';
  };

  await runChecks(dir, { run: fakeRun, e2eCmd: 'playwright test' });

  assert.deepEqual(seen, ['postgresql://localhost:4137/app']);
});

// Isolation is the whole point of those ports. A value left in the developer's own
// shell must never quietly replace the one this ticket actually holds.
test('the ticket env beats an ambient value of the same name', async () => {
  const dir = tempWorktreeWithEnv({ test: 'echo testing' }, 'DB_PORT=4137\n');
  process.env.DB_PORT = '5432';
  let seen: Record<string, string | undefined> | undefined;
  const fakeRun = (_cmd: string, _args: string[], options: { env?: NodeJS.ProcessEnv }) => {
    seen = options.env;
    return 'ok\n';
  };

  try {
    await runChecks(dir, { run: fakeRun });
  } finally {
    delete process.env.DB_PORT;
  }

  assert.equal(seen!.DB_PORT, '4137');
  // The rest of the environment still has to be there — PATH above all.
  assert.equal(seen!.PATH, process.env.PATH);
});

test('a worktree with no .env.glafka still runs with the normal environment', async () => {
  const dir = tempProjectDir({ test: 'echo testing' });
  let seen: Record<string, string | undefined> | undefined;
  const fakeRun = (_cmd: string, _args: string[], options: { env?: NodeJS.ProcessEnv }) => {
    seen = options.env;
    return 'ok\n';
  };

  await runChecks(dir, { run: fakeRun });

  assert.equal(seen!.PATH, process.env.PATH);
});
