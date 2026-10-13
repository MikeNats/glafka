import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { wrap, seatbeltProfile, selfTest } from '../../installKit/guardrails/layers/sandbox.js';
import { makeGitRepo } from '../helpers/gitFixture.js';
import { genesis } from '../../src/commands/genesis/genesis.js';
import type { Policy } from '../../installKit/guardrails/types/policy.js';
import { makeTempDir } from '../helpers/tempDir.js';

// Most tests here just read the command we build. A few near the bottom
// really start a container or a sandbox and run git inside it.

function dockerReady() {
  if (spawnSync('command', ['-v', 'docker'], { shell: true }).status !== 0) return false;
  return spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
}

function seatbeltReady() {
  if (os.platform() !== 'darwin') return false;
  return spawnSync('command', ['-v', 'sandbox-exec'], { shell: true }).status === 0;
}

const DOCKER_UNAVAILABLE = dockerReady() ? false : 'docker is not installed or not running here';
const SEATBELT_UNAVAILABLE = seatbeltReady()
  ? false
  : 'sandbox-exec is macOS-only and not available here';

function dockerPolicy(overrides: Partial<Policy['sandbox']> = {}): Pick<Policy, 'sandbox'> {
  return {
    sandbox: {
      enabled: true,
      backend: 'docker',
      image: 'node:22',
      network: false,
      extraMounts: [],
      ...overrides,
    },
  };
}

function seatbeltPolicy(overrides: Partial<Policy['sandbox']> = {}): Pick<Policy, 'sandbox'> {
  return {
    sandbox: {
      enabled: true,
      backend: 'seatbelt',
      image: null,
      network: false,
      extraMounts: [],
      ...overrides,
    },
  };
}

// wrap() looks at the real disk to find the git folder, so it needs a real
// worktree, not a made-up path. One real ticket, shared by the tests below.
async function realTicket() {
  const repoRoot = makeGitRepo();
  const stateDir = path.join(repoRoot, '.glafka');
  const ticket = await genesis({ repoRoot, stateDir, content: 'sandboxed work' });
  const scratch = makeTempDir('scratch');
  return { repoRoot, stateDir, ticket, scratch };
}

test('wrap does nothing when the sandbox layer is off', { concurrency: true }, () => {
  const result = wrap(
    { sandbox: { enabled: false, backend: 'none', image: null, network: true, extraMounts: [] } },
    ['echo', 'hi'],
    {
      worktree: '/w',
      scratch: '/s',
      env: {},
      stateDir: '/state',
    },
  );

  assert.deepEqual(result, { argv: ['echo', 'hi'], backend: 'none', note: 'sandbox layer off' });
});

// A cage that fails must say so, and never pretend the command was caged.
// Fake paths are fine, because we return before touching the disk.
test(
  'wrap reports NOT SANDBOXED with the argv unchanged when the chosen backend is unavailable',
  { concurrency: true },
  () => {
    // This backend name is not real on purpose. The cast is only there
    // to get past the type check.
    const policy: Pick<Policy, 'sandbox'> = {
      sandbox: {
        enabled: true,
        backend: 'made-up-backend' as Policy['sandbox']['backend'],
        image: null,
        network: false,
        extraMounts: [],
      },
    };
    const result = wrap(policy, ['echo', 'hi'], {
      worktree: '/w',
      scratch: '/s',
      env: {},
      stateDir: '/state',
    });

    assert.deepEqual(result.argv, ['echo', 'hi']);
    assert.equal(result.backend, 'none');
    assert.equal(result.failed, true);
    assert.match(result.note, /NOT SANDBOXED/);
  },
);

// TMPDIR is set to the scratch folder and passed into the container.
// Without mounting scratch, that path does not exist inside the container.
test(
  'wrap mounts both the worktree AND the scratch dir into the docker container',
  { skip: DOCKER_UNAVAILABLE },
  async () => {
    const { ticket, scratch, stateDir } = await realTicket();
    const result = wrap(dockerPolicy(), ['echo', 'hi'], {
      worktree: ticket.worktree!,
      scratch,
      env: {},
      stateDir,
    });

    assert.equal(result.backend, 'docker');
    const volumes: string[] = [];
    result.argv.forEach((a, i) => {
      if (a === '--volume') volumes.push(result.argv[i + 1]);
    });
    assert.ok(
      volumes.includes(`${ticket.worktree!}:${ticket.worktree!}`),
      'worktree must be mounted',
    );
    assert.ok(
      volumes.includes(`${scratch}:${scratch}`),
      'scratch must be mounted — this is the fix for A2, TMPDIR pointing nowhere inside the container',
    );
  },
);

// A worktree's ".git" is a file pointing at the main checkout's .git folder.
// Without mounting that too, every git command in the container fails.
test(
  "wrap also mounts the repo's shared .git directory into the docker container",
  { skip: DOCKER_UNAVAILABLE },
  async () => {
    const { repoRoot, ticket, scratch, stateDir } = await realTicket();
    const result = wrap(dockerPolicy(), ['git', 'status'], {
      worktree: ticket.worktree!,
      scratch,
      env: {},
      stateDir,
    });

    const volumes: string[] = [];
    result.argv.forEach((a, i) => {
      if (a === '--volume') volumes.push(result.argv[i + 1]);
    });
    // Git writes this path in its full real form, so we do the same here.
    // Otherwise a repo under a linked temp folder would look different.
    const commonGitDir = fs.realpathSync(path.join(repoRoot, '.git'));
    assert.ok(
      volumes.includes(`${commonGitDir}:${commonGitDir}`),
      'the shared .git directory must be mounted',
    );
  },
);

// Hooks are shared with your own checkout, and git only reads them.
// An agent must never be able to put one there.
test(
  'wrap overlays the shared .git/hooks directory read-only in docker',
  { skip: DOCKER_UNAVAILABLE },
  async () => {
    const { repoRoot, ticket, scratch, stateDir } = await realTicket();
    const result = wrap(dockerPolicy(), ['git', 'status'], {
      worktree: ticket.worktree!,
      scratch,
      env: {},
      stateDir,
    });

    const hooksDir = path.join(fs.realpathSync(path.join(repoRoot, '.git')), 'hooks');
    assert.ok(
      result.argv.includes(`${hooksDir}:${hooksDir}:ro`),
      'hooks must be mounted read-only, layered after the read-write .git mount',
    );
  },
);

// Our user id has no entry inside the image, so git refuses with "dubious
// ownership". We mark this one exact path as safe, not everything.
test(
  "wrap tells git to trust the worktree's ownership inside docker",
  { skip: DOCKER_UNAVAILABLE },
  async () => {
    const { ticket, scratch, stateDir } = await realTicket();
    const result = wrap(dockerPolicy(), ['git', 'status'], {
      worktree: ticket.worktree!,
      scratch,
      env: {},
      stateDir,
    });

    assert.ok(result.argv.includes('GIT_CONFIG_COUNT=1'));
    assert.ok(result.argv.includes('GIT_CONFIG_KEY_0=safe.directory'));
    assert.ok(result.argv.includes(`GIT_CONFIG_VALUE_0=${ticket.worktree!}`));
  },
);

test(
  "wrap's docker mode is mounted at the SAME path on both sides, not remapped",
  { skip: DOCKER_UNAVAILABLE },
  async () => {
    const { ticket, scratch, stateDir } = await realTicket();
    const result = wrap(dockerPolicy(), ['echo'], {
      worktree: ticket.worktree!,
      scratch,
      env: { TMPDIR: scratch },
      stateDir,
    });

    // If the container used a different path inside, TMPDIR would point
    // at nothing.
    assert.ok(result.argv.includes(`TMPDIR=${scratch}`));
    const scratchMount = result.argv.find(
      (a, i) => result.argv[i - 1] === '--volume' && a.startsWith(`${scratch}:`),
    );
    assert.equal(scratchMount, `${scratch}:${scratch}`);
  },
);

// Secrets used to sit on the command line, where `ps` could read them.
// Now we pass the name only, and docker reads the value from its own env.
test(
  'wrap keeps real credentials off argv, but still bakes ordinary vars in as K=V',
  { skip: DOCKER_UNAVAILABLE },
  async () => {
    const { ticket, scratch, stateDir } = await realTicket();
    const env = {
      PATH: '/usr/bin',
      TMPDIR: scratch,
      ANTHROPIC_API_KEY: 'sk-ant-api03-REALSECRET-xyz',
      ANTHROPIC_AUTH_TOKEN: 'auth-secret-abc',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret-def',
      // glafka drives other agents too, and these used to be baked in as K=V.
      OPENAI_API_KEY: 'sk-openai-REALSECRET-111',
      GEMINI_API_KEY: 'gem-REALSECRET-222',
      DATABASE_URL: 'postgres://u:REALSECRET333@host/db',
    };
    const result = wrap(dockerPolicy(), ['claude', '-p'], {
      worktree: ticket.worktree!,
      scratch,
      env,
      stateDir,
    });

    const joined = result.argv.join(' ');
    assert.ok(!joined.includes('sk-ant-api03-REALSECRET-xyz'));
    assert.ok(!joined.includes('auth-secret-abc'));
    assert.ok(!joined.includes('oauth-secret-def'));
    assert.ok(!joined.includes('sk-openai-REALSECRET-111'));
    assert.ok(!joined.includes('gem-REALSECRET-222'));
    assert.ok(!joined.includes('REALSECRET333'));
    for (const name of [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'OPENAI_API_KEY',
      'GEMINI_API_KEY',
      'DATABASE_URL',
    ]) {
      assert.ok(result.argv.includes(name), `${name} must be passed by name only`);
    }
    assert.ok(result.argv.includes('PATH=/usr/bin'));
    assert.ok(result.argv.includes(`TMPDIR=${scratch}`));
  },
);

test(
  'wrap still mounts extraMounts on top of worktree and scratch',
  { skip: DOCKER_UNAVAILABLE },
  async () => {
    const { ticket, scratch, stateDir } = await realTicket();
    const result = wrap(dockerPolicy({ extraMounts: ['/host/cache:/host/cache'] }), ['echo'], {
      worktree: ticket.worktree!,
      scratch,
      env: {},
      stateDir,
    });

    const volumes: string[] = [];
    result.argv.forEach((a, i) => {
      if (a === '--volume') volumes.push(result.argv[i + 1]);
    });
    assert.ok(volumes.includes('/host/cache:/host/cache'));
  },
);

// Seatbelt already allowed read and write in scratch. This only builds text,
// so a fake git path is fine here.
test(
  "seatbeltProfile already allows both read and write inside scratch, unlike docker's old mount list",
  { concurrency: true },
  () => {
    const profile = seatbeltProfile({
      worktree: '/repo/.worktrees/2026-08-07-add-dark-mode',
      scratch: '/tmp/glafka-t-1',
      home: os.homedir(),
      commonGitDir: '/repo/.git',
      allowNetwork: false,
    });

    assert.match(profile, /\(allow file-read\*[\s\S]*"\/tmp\/glafka-t-1"/);
    assert.match(profile, /\(allow file-write\*[\s\S]*"\/tmp\/glafka-t-1"/);
  },
);

// The worktree's ".git" file points outside the worktree.
// Without this rule, every git command in the cage fails.
test(
  'seatbeltProfile allows both read and write on the shared .git directory',
  { concurrency: true },
  () => {
    const profile = seatbeltProfile({
      worktree: '/repo/.worktrees/2026-08-07-add-dark-mode',
      scratch: '/tmp/glafka-t-1',
      home: os.homedir(),
      commonGitDir: '/repo/.git',
      allowNetwork: false,
    });

    assert.match(profile, /\(allow file-read\*[\s\S]*"\/repo\/\.git"/);
    assert.match(profile, /\(allow file-write\*[\s\S]*"\/repo\/\.git"/);
  },
);

// But not hooks. They are shared with your own checkout,
// and git only ever reads them.
test(
  'seatbeltProfile denies writes specifically under the shared .git/hooks directory',
  { concurrency: true },
  () => {
    const profile = seatbeltProfile({
      worktree: '/repo/.worktrees/2026-08-07-add-dark-mode',
      scratch: '/tmp/glafka-t-1',
      home: os.homedir(),
      commonGitDir: '/repo/.git',
      allowNetwork: false,
    });

    assert.match(profile, /\(deny file-write\* \(subpath "\/repo\/\.git\/hooks"\)\)/);
    // Must come AFTER the allow line, because the last match wins.
    const allowIdx = profile.indexOf(
      '(allow file-write*\n  (subpath "/repo/.worktrees/2026-08-07-add-dark-mode")',
    );
    const denyIdx = profile.indexOf('(deny file-write* (subpath "/repo/.git/hooks"))');
    assert.ok(allowIdx !== -1 && denyIdx !== -1 && denyIdx > allowIdx);
  },
);

// A submodule's own hooks and config under .git/modules run on the host too,
// but the deny above only ever covered .git/hooks, so they stayed writable.
test(
  'seatbeltProfile denies writes to every submodule hooks folder and config file',
  { concurrency: true },
  () => {
    const profile = seatbeltProfile({
      worktree: '/repo/.worktrees/2026-08-07-add-dark-mode',
      scratch: '/tmp/glafka-t-1',
      home: os.homedir(),
      commonGitDir: '/repo/.git',
      allowNetwork: false,
      submodule: {
        hooks: ['/repo/.git/modules/vendor/hooks'],
        configs: ['/repo/.git/modules/vendor/config'],
      },
      worktreeGitDir: '/repo/.git/worktrees/2026-08-07-add-dark-mode',
    });

    const allowIdx = profile.indexOf(
      '(allow file-write*\n  (subpath "/repo/.worktrees/2026-08-07-add-dark-mode")',
    );
    for (const line of [
      '(deny file-write* (subpath "/repo/.git/modules/vendor/hooks"))',
      '(deny file-write* (literal "/repo/.git/modules/vendor/config"))',
    ]) {
      assert.ok(profile.includes(line), line);
      // The last match wins, so a deny before the allow would do nothing.
      assert.ok(profile.indexOf(line) > allowIdx, `${line} must come after the allow`);
    }
  },
);

// Every ticket's git metadata sits side by side under .git/worktrees. One
// coder writing into another's would corrupt a ticket it does not own.
test(
  'seatbeltProfile denies the whole .git/worktrees folder, then gives back only our own',
  { concurrency: true },
  () => {
    const profile = seatbeltProfile({
      worktree: '/repo/.worktrees/2026-08-07-add-dark-mode',
      scratch: '/tmp/glafka-t-1',
      home: os.homedir(),
      commonGitDir: '/repo/.git',
      allowNetwork: false,
      worktreeGitDir: '/repo/.git/worktrees/2026-08-07-add-dark-mode',
    });

    const denyIdx = profile.indexOf('(deny file-write* (subpath "/repo/.git/worktrees"))');
    const backIdx = profile.indexOf(
      '(allow file-write* (subpath "/repo/.git/worktrees/2026-08-07-add-dark-mode"))',
    );
    assert.ok(denyIdx !== -1, 'the whole worktrees folder must be denied');
    assert.ok(backIdx !== -1, 'our own git dir must be given back');
    // Order is the whole point: ours has to be the LAST rule that matches.
    assert.ok(backIdx > denyIdx, 'the give-back must come after the deny');
  },
);

// To open that path, the system checks every folder above it, and most of
// those sit under home. Without this, git can not find its own repo.
test(
  'seatbeltProfile allows metadata-only reads across the whole home directory',
  { concurrency: true },
  () => {
    const profile = seatbeltProfile({
      worktree: '/repo/.worktrees/2026-08-07-add-dark-mode',
      scratch: '/tmp/glafka-t-1',
      home: '/Users/somebody',
      commonGitDir: '/repo/.git',
      allowNetwork: false,
    });

    assert.match(profile, /\(allow file-read-metadata \(subpath "\/Users\/somebody"\)\)/);
  },
);

// Git reads your global config every single time. A blocked read kills it,
// while a missing file is only a warning.
test(
  'seatbeltProfile allows reading the two global git config file locations',
  { concurrency: true },
  () => {
    const profile = seatbeltProfile({
      worktree: '/repo/.worktrees/2026-08-07-add-dark-mode',
      scratch: '/tmp/glafka-t-1',
      home: '/Users/somebody',
      commonGitDir: '/repo/.git',
      allowNetwork: false,
    });

    assert.match(profile, /\(literal "\/Users\/somebody\/\.gitconfig"\)/);
    assert.match(profile, /\(literal "\/Users\/somebody\/\.config\/git\/config"\)/);
  },
);

// Host git follows these files after the cage, so the agent must not change them.
test('seatbeltProfile denies writes to the files that say where the repo is', () => {
  const worktreeGitDir = '/repo/.git/worktrees/t-1';
  const profile = seatbeltProfile({
    worktree: '/repo/.worktrees/t-1',
    scratch: '/tmp/glafka-t-1',
    home: '/Users/somebody',
    commonGitDir: '/repo/.git',
    allowNetwork: false,
    worktreeGitDir,
  });

  for (const file of [
    '/repo/.worktrees/t-1/.git',
    `${worktreeGitDir}/commondir`,
    `${worktreeGitDir}/gitdir`,
    `${worktreeGitDir}/config.worktree`,
  ]) {
    assert.ok(profile.includes(`(deny file-write* (literal "${file}"))`), file);
  }
  // A deny only works AFTER the allow it narrows. The last match wins.
  assert.ok(
    profile.indexOf(`(allow file-write* (subpath "${worktreeGitDir}"))`) <
      profile.indexOf(`(deny file-write* (literal "${worktreeGitDir}/gitdir"))`),
  );
});

// The real thing, start to finish: a real worktree, a real cage,
// real git commands. Every other test here only reads text.
test(
  'a real git workflow (status/add/commit/log) works inside a real seatbelt cage',
  { skip: SEATBELT_UNAVAILABLE },
  async () => {
    const { ticket, scratch, stateDir } = await realTicket();
    const run = (argv: string[]) => {
      const wrapped = wrap(seatbeltPolicy(), argv, {
        worktree: ticket.worktree!,
        scratch,
        env: {},
        stateDir,
      });
      return spawnSync(wrapped.argv[0], wrapped.argv.slice(1), {
        cwd: ticket.worktree!,
        encoding: 'utf8',
      });
    };

    assert.equal(run(['git', 'status']).status, 0);
    fs.writeFileSync(path.join(ticket.worktree!, 'sandboxed.txt'), 'hi\n');
    assert.equal(run(['git', 'add', 'sandboxed.txt']).status, 0);
    assert.equal(run(['git', 'commit', '-q', '-m', 'sandboxed commit']).status, 0);
    const log = run(['git', 'log', '--oneline', '-1']);
    assert.equal(log.status, 0);
    assert.match(log.stdout, /sandboxed commit/);

    // The hooks rule, proven for real, not just as text.
    const hookWrite = run([
      'sh',
      '-c',
      'echo evil > "$(git rev-parse --git-common-dir)/hooks/pre-commit"',
    ]);
    assert.notEqual(hookWrite.status, 0);

    // The ".git" pointer, proven for real. Host git follows it after the cage.
    const pointer = path.join(ticket.worktree!, '.git');
    const before = fs.readFileSync(pointer, 'utf8');
    assert.notEqual(run(['sh', '-c', 'echo "gitdir: /tmp/evil" > .git']).status, 0);
    assert.equal(fs.readFileSync(pointer, 'utf8'), before);

    // The wall must still be up. We only opened what git needs.
    const sshRead = run(['ls', path.join(os.homedir(), '.ssh')]);
    assert.notEqual(sshRead.status, 0);
  },
);

// Same real workflow, the docker backend.
test(
  'a real git workflow (status/add/commit/log) works inside a real docker cage',
  { skip: DOCKER_UNAVAILABLE },
  async () => {
    const { ticket, scratch, stateDir } = await realTicket();
    const run = (argv: string[]) => {
      const wrapped = wrap(dockerPolicy(), argv, {
        worktree: ticket.worktree!,
        scratch,
        env: {},
        stateDir,
      });
      return spawnSync(wrapped.argv[0], wrapped.argv.slice(1), {
        cwd: ticket.worktree!,
        encoding: 'utf8',
      });
    };

    assert.equal(run(['git', 'status']).status, 0);
    fs.writeFileSync(path.join(ticket.worktree!, 'sandboxed.txt'), 'hi\n');
    assert.equal(run(['git', 'add', 'sandboxed.txt']).status, 0);
    assert.equal(
      run([
        'git',
        '-c',
        'user.email=t@t.dev',
        '-c',
        'user.name=t',
        'commit',
        '-q',
        '-m',
        'sandboxed commit',
      ]).status,
      0,
    );
    const log = run(['git', 'log', '--oneline', '-1']);
    assert.equal(log.status, 0);
    assert.match(log.stdout, /sandboxed commit/);

    const hookWrite = run(['sh', '-c', 'echo evil > .git/hooks/pre-commit']);
    assert.notEqual(hookWrite.status, 0);

    const pointer = path.join(ticket.worktree!, '.git');
    const before = fs.readFileSync(pointer, 'utf8');
    assert.notEqual(run(['sh', '-c', 'echo "gitdir: /tmp/evil" > .git']).status, 0);
    assert.equal(fs.readFileSync(pointer, 'utf8'), before);

    const network = run([
      'node',
      '-e',
      "require('node:dns').promises.resolve('example.com').then(()=>process.exit(0),()=>process.exit(1))",
    ]);
    assert.notEqual(network.status, 0);
  },
);

// The control test used to be `ls .`, which passed even when git could not
// run at all. It must prove the real thing the coder needs.
test(
  "selfTest's control probe actually proves git works, not just that something ran",
  { skip: SEATBELT_UNAVAILABLE },
  async () => {
    const { ticket, scratch, stateDir } = await realTicket();
    const results = selfTest(seatbeltPolicy(), { worktree: ticket.worktree!, scratch, stateDir });

    const control = results.find((r) => r.label === 'git works inside the cage');
    assert.ok(control, 'selfTest must report a control probe under this label');
    assert.equal(control.pass, true);
  },
);

// The default image has no agent program in it, and nothing used to check.
// Two cases here: one program that exists, and one that does not.
test(
  'selfTest reports whether the configured agent CLI is actually present in the cage',
  { skip: SEATBELT_UNAVAILABLE },
  async () => {
    const { ticket, scratch, stateDir } = await realTicket();

    const present = selfTest(seatbeltPolicy(), {
      worktree: ticket.worktree!,
      scratch,
      stateDir,
      agentCmd: 'node --version',
    });
    const presentProbe = present.find((r) => r.label === 'agent CLI present');
    assert.ok(presentProbe);
    assert.equal(presentProbe.pass, true);

    const absent = selfTest(seatbeltPolicy(), {
      worktree: ticket.worktree!,
      scratch,
      stateDir,
      agentCmd: 'definitely-not-a-real-agent-binary-xyz',
    });
    const absentProbe = absent.find((r) => r.label === 'agent CLI present');
    assert.ok(absentProbe);
    assert.equal(absentProbe.pass, false);
    // A second failure here would just be noise after the first one.
    assert.ok(!absent.some((r) => r.label === 'agent CLI can reach its API'));
  },
);

// This level always blocks the network, so even a program that is there
// can not reach its API. We say it once the program itself is found.
test(
  'selfTest names the network limitation once the agent CLI is confirmed present',
  { skip: SEATBELT_UNAVAILABLE },
  async () => {
    const { ticket, scratch, stateDir } = await realTicket();
    const results = selfTest(seatbeltPolicy(), {
      worktree: ticket.worktree!,
      scratch,
      stateDir,
      agentCmd: 'node --version',
    });

    const reach = results.find((r) => r.label === 'agent CLI can reach its API');
    assert.ok(reach, 'must be reported once the binary itself is confirmed present');
    assert.equal(reach.pass, null);
    assert.match(reach.detail, /neverOverridable/);
  },
);

// With no agent command given, selfTest must behave as before.
// Callers must not suddenly see new tests appear.
test(
  'selfTest skips the agent-CLI probes entirely when no agentCmd is given',
  { skip: SEATBELT_UNAVAILABLE },
  async () => {
    const { ticket, scratch, stateDir } = await realTicket();
    const results = selfTest(seatbeltPolicy(), { worktree: ticket.worktree!, scratch, stateDir });

    assert.ok(!results.some((r) => r.label === 'agent CLI present'));
    assert.ok(!results.some((r) => r.label === 'agent CLI can reach its API'));
  },
);

// Docker used to mount hooks read-only only if the folder already existed.
// Without the mount, an agent could add a hook that runs uncaged later.
test('docker mounts .git/hooks read-only even when it does not exist yet', () => {
  const repoRoot = fs.realpathSync(makeGitRepo());
  const worktree = path.join(repoRoot, '.worktrees', '2026-08-02-cage-the-coder');
  execFileSync('git', ['worktree', 'add', '-q', '-b', '2026-08-02-cage-the-coder', worktree], {
    cwd: repoRoot,
  });
  const scratch = makeTempDir('scratch');
  const stateDir = path.join(repoRoot, '.glafka');

  const hooksDir = path.join(repoRoot, '.git', 'hooks');
  fs.rmSync(hooksDir, { recursive: true, force: true });
  assert.equal(fs.existsSync(hooksDir), false, 'precondition: no hooks dir');

  const policy = dockerPolicy();
  const wrapped = wrap(policy, ['true'], { worktree, scratch, env: {}, stateDir });

  assert.ok(
    wrapped.argv.some((a) => a === `${hooksDir}:${hooksDir}:ro`),
    'the read-only hooks mount must be emitted regardless',
  );
});
