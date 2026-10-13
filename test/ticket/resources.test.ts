import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeGitRepo, makeRepoWithSubmodule, withFileProtocol } from '../helpers/gitFixture.js';
import net from 'node:net';
import { makeTempDir } from '../helpers/tempDir.js';
import {
  acquireResources,
  releaseResources,
  releaseGitResources,
  findFreePort,
  runIsolationHook,
  runBootstrap,
  DEFAULT_ISOLATION_HOOK_TIMEOUT_MS,
} from '../../src/ticket/resources.js';
import {
  writeTicket,
  recordStage,
  STAGES,
  archiveClosedTicket,
} from '../../src/ticket/ticketStore.js';
import {
  writeProvisioningLock,
  portsLockPath,
  ticketsDir,
  closedTicketsDir,
  ticketFiles,
  ticketScratchPath,
  runsDir,
  runFiles,
} from '../../src/ticket/paths.js';
import { spawnBackground } from '../../src/ticket/background.js';
import { isolationProfilePath, writeDoc } from '../../src/memory/docsStore.js';

const PROFILE = {
  services: [
    { name: 'ui', envVars: ['UI_PORT'] },
    { name: 'backend', envVars: ['PORT', 'SERVER_PORT'] },
  ],
  e2e: { services: [{ name: 'e2e-db', envVars: ['E2E_DB_PORT'] }] },
};

function envOf(worktree: string) {
  const content = fs.readFileSync(path.join(worktree, '.env.glafka'), 'utf8');
  return Object.fromEntries(
    content
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const at = line.indexOf('=');
        return [line.slice(0, at), line.slice(at + 1)];
      }),
  );
}

function tempStateDir() {
  return makeTempDir('res');
}

function branches(repoRoot: string) {
  return execFileSync('git', ['branch', '--list', 'glafka/*'], { cwd: repoRoot, encoding: 'utf8' });
}

test(
  'acquire creates the worktree, the branch, a port, and .env.glafka',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();

    const res = await acquireResources({
      repoRoot,
      stateDir: tempStateDir(),
      id: '2026-08-03-a-stored-ticket',
      baseRef: 'main',
    });

    assert.equal(res.branch!, 'glafka/2026-08-03-a-stored-ticket');
    assert.equal(res.worktree!, path.join(repoRoot, '.worktrees', '2026-08-03-a-stored-ticket'));
    assert.equal(fs.existsSync(res.worktree!), true);
    assert.equal(typeof res.port, 'number');
    assert.equal(res.isolationPorts, null);
    assert.deepEqual(envOf(res.worktree!), {
      PORT: String(res.port),
      GLAFKA_TICKET_ID: '2026-08-03-a-stored-ticket',
    });
  },
);

// Ports live on the ticket, not in a booking file. This is what hands them back.
test(
  'with a profile, every service gets its own port and no plain PORT is set',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    writeDoc(isolationProfilePath(repoRoot), JSON.stringify(PROFILE));

    const res = await acquireResources({
      repoRoot,
      stateDir: tempStateDir(),
      id: '2026-08-04-acquire-a-worktree',
      baseRef: 'main',
    });

    assert.equal(res.port, null);
    assert.deepEqual(Object.keys(res.isolationPorts!), ['ui', 'backend', 'e2e-db']);

    const ports = Object.values(res.isolationPorts!);
    assert.equal(new Set(ports).size, 3, `services shared a port: ${ports}`);

    const env = envOf(res.worktree!);
    assert.equal(env.PORT, env.SERVER_PORT, 'two env vars on one service must share its port');
    assert.equal(env.UI_PORT, String(res.isolationPorts!.ui));
    assert.equal(env.E2E_DB_PORT, String(res.isolationPorts!['e2e-db']));
  },
);

// A port is not in use at the moment we pick it, so without the skip list
// the test would call the same one free every time. One ticket only here.
test('services within one ticket never collide on a port', { concurrency: true }, async () => {
  const repoRoot = makeGitRepo();
  writeDoc(isolationProfilePath(repoRoot), JSON.stringify(PROFILE));

  const { isolationPorts } = await acquireResources({
    repoRoot,
    stateDir: tempStateDir(),
    id: '2026-08-04-service-ports-three',
    baseRef: 'main',
    // Exactly as many ports as services, so a clash can not hide.
    // It turns into a plain failure instead.
    portRange: { start: 4821, end: 4823 },
  });

  const ports = Object.values(isolationPorts!);
  assert.deepEqual(ports.slice().sort(), [4821, 4822, 4823]);
});

test(
  'a setupCmd sees the ports as real env vars and can add derived values',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    writeDoc(
      isolationProfilePath(repoRoot),
      JSON.stringify({
        services: [{ name: 'db', envVars: ['DB_PORT'] }],
        setupCmd: 'echo "DATABASE_URL=postgresql://localhost:$DB_PORT/app"',
      }),
    );

    const res = await acquireResources({
      repoRoot,
      stateDir: tempStateDir(),
      id: '2026-08-04-service-ports-one',
      baseRef: 'main',
    });

    const env = envOf(res.worktree!);
    assert.equal(env.DATABASE_URL, `postgresql://localhost:${res.isolationPorts!.db}/app`);
  },
);

// A ticket gets its own empty database. Nothing filled it, so every ticket started
// against empty tables and the seeding was left as a manual step nobody was told about.
test('a seedCmd runs at provisioning, after setupCmd', { concurrency: true }, async () => {
  const repoRoot = makeGitRepo();
  writeDoc(
    isolationProfilePath(repoRoot),
    JSON.stringify({
      services: [{ name: 'db', envVars: ['DB_PORT'] }],
      setupCmd: 'echo "DATABASE_URL=postgresql://localhost:$DB_PORT/app"',
      seedCmd: 'echo "SEEDED=yes"',
    }),
  );

  const res = await acquireResources({
    repoRoot,
    stateDir: tempStateDir(),
    id: '2026-08-04-seed-runs',
    baseRef: 'main',
  });

  assert.equal(envOf(res.worktree!).SEEDED, 'yes');
});

// Seeding needs the connection string setupCmd just printed. Each hook's output
// used to land in the env file only, so the next hook could not see it.
test('a seedCmd sees what setupCmd printed', { concurrency: true }, async () => {
  const repoRoot = makeGitRepo();
  writeDoc(
    isolationProfilePath(repoRoot),
    JSON.stringify({
      services: [{ name: 'db', envVars: ['DB_PORT'] }],
      setupCmd: 'echo "DATABASE_URL=postgresql://localhost:$DB_PORT/app"',
      seedCmd: 'echo "SEEDED_INTO=$DATABASE_URL"',
    }),
  );

  const res = await acquireResources({
    repoRoot,
    stateDir: tempStateDir(),
    id: '2026-08-04-seed-sees-setup',
    baseRef: 'main',
  });

  const env = envOf(res.worktree!);
  assert.equal(env.SEEDED_INTO, `postgresql://localhost:${res.isolationPorts!.db}/app`);
});

// A seed that fails leaves half-filled tables. Better to fail provisioning
// than to hand a coder a database nobody can trust.
test('a failing seedCmd fails provisioning', { concurrency: true }, async () => {
  const repoRoot = makeGitRepo();
  writeDoc(
    isolationProfilePath(repoRoot),
    JSON.stringify({ services: [], setupCmd: 'true', seedCmd: 'exit 1' }),
  );

  await assert.rejects(
    acquireResources({
      repoRoot,
      stateDir: tempStateDir(),
      id: '2026-08-04-seed-fails',
      baseRef: 'main',
    }),
    /seedCmd/,
  );
});

// A failure after the worktree exists leaves a folder and a branch that no
// ticket points at. Only this code knows about them, so it must clean up.
test(
  'a failing setupCmd leaves no worktree and no branch behind',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    writeDoc(
      isolationProfilePath(repoRoot),
      JSON.stringify({
        services: [{ name: 'db', envVars: ['DB_PORT'] }],
        setupCmd: 'exit 1',
      }),
    );

    await assert.rejects(() =>
      acquireResources({
        repoRoot,
        stateDir: tempStateDir(),
        id: '2026-08-04-service-ports-two',
        baseRef: 'main',
      }),
    );

    assert.equal(
      fs.existsSync(path.join(repoRoot, '.worktrees', '2026-08-04-service-ports-two')),
      false,
    );
    assert.equal(branches(repoRoot).trim(), '');
  },
);

test('release removes the worktree but keeps the branch', { concurrency: true }, async () => {
  const repoRoot = makeGitRepo();
  const res = await acquireResources({
    repoRoot,
    stateDir: tempStateDir(),
    id: '2026-08-04-release-keeps-the-branch',
    baseRef: 'main',
  });

  await releaseResources({
    repoRoot,
    ticket: { ...res, id: '2026-08-04-release-keeps-the-branch' },
  });

  assert.equal(fs.existsSync(res.worktree!), false);
  // The branch is the only record of the work, so closing must not destroy it.
  assert.match(branches(repoRoot), /2026-08-04-release-keeps-the-branch/);
});

// The teardown command may need to run inside the worktree,
// so it has to run before we delete it.
test(
  "teardownCmd runs while the worktree still exists, with the ticket's own ports",
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const marker = path.join(repoRoot, 'teardown-saw.txt');
    writeDoc(
      isolationProfilePath(repoRoot),
      JSON.stringify({
        services: [{ name: 'db', envVars: ['DB_PORT'] }],
        teardownCmd: `echo "$DB_PORT $GLAFKA_TICKET_ID $(pwd)" > "${marker}"`,
      }),
    );
    const res = await acquireResources({
      repoRoot,
      stateDir: tempStateDir(),
      id: '2026-08-04-release-keeps-the-branch-again',
      baseRef: 'main',
    });
    // Worked out before release. We can not read the real path once it is gone.
    const worktreeReal = fs.realpathSync(res.worktree!);

    await releaseResources({
      repoRoot,
      ticket: { ...res, id: '2026-08-04-release-keeps-the-branch-again' },
    });

    const [port, id, cwd] = fs.readFileSync(marker, 'utf8').trim().split(' ');
    assert.equal(port, String(res.isolationPorts!.db));
    assert.equal(id, '2026-08-04-release-keeps-the-branch-again');
    assert.equal(cwd, worktreeReal);
    assert.equal(fs.existsSync(res.worktree!), false, 'worktree should be gone by now');
  },
);

// The profile can change while a ticket is open. A port whose service is gone
// has no env var to set, and must not stop teardown.
test('release skips a service the profile no longer names', { concurrency: true }, async () => {
  const repoRoot = makeGitRepo();
  const marker = path.join(repoRoot, 'shrunk.txt');
  writeDoc(
    isolationProfilePath(repoRoot),
    JSON.stringify({
      services: [{ name: 'db', envVars: ['DB_PORT'] }],
      teardownCmd: `echo "[$DB_PORT][$GONE_PORT]" > "${marker}"`,
    }),
  );
  const res = await acquireResources({
    repoRoot,
    stateDir: tempStateDir(),
    id: '2026-08-04-release-skips-a-dropped-service',
    baseRef: 'main',
  });

  await releaseResources({
    repoRoot,
    ticket: {
      ...res,
      id: '2026-08-04-release-skips-a-dropped-service',
      isolationPorts: { ...res.isolationPorts!, gone: 9999 },
    },
  });

  assert.equal(fs.readFileSync(marker, 'utf8').trim(), `[${res.isolationPorts!.db}][]`);
});

// A profile with no services can still make something real, like a database.
// Teardown used to be skipped in that case, so nothing was cleaned up.
test(
  'release runs teardownCmd for a services-less profile, where isolationPorts is null',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const marker = path.join(repoRoot, 'teardown-ran.txt');
    writeDoc(
      isolationProfilePath(repoRoot),
      JSON.stringify({
        setupCmd: 'true',
        teardownCmd: `echo "$GLAFKA_TICKET_ID" > "${marker}"`,
      }),
    );
    const res = await acquireResources({
      repoRoot,
      stateDir: tempStateDir(),
      id: '2026-08-04-release-skips-a-dropped-service-again',
      baseRef: 'main',
    });
    assert.equal(res.isolationPorts, null);

    await releaseResources({
      repoRoot,
      ticket: { ...res, id: '2026-08-04-release-skips-a-dropped-service-again' },
    });

    assert.equal(
      fs.readFileSync(marker, 'utf8').trim(),
      '2026-08-04-release-skips-a-dropped-service-again',
    );
  },
);

// The cleanup path used to always send null ports, even when real ones were
// already picked. That quietly skipped teardown for anything setupCmd made.
test(
  "acquire's own rollback runs teardownCmd with the real ports when a later step fails",
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const marker = path.join(repoRoot, 'teardown-on-rollback.txt');
    writeDoc(
      isolationProfilePath(repoRoot),
      JSON.stringify({
        services: [{ name: 'db', envVars: ['DB_PORT'] }],
        setupCmd: 'true',
        teardownCmd: `echo "$DB_PORT" > "${marker}"`,
        e2e: { setupCmd: 'exit 1' },
      }),
    );

    await assert.rejects(() =>
      acquireResources({
        repoRoot,
        stateDir: tempStateDir(),
        id: '2026-08-04-rollback-runs-teardown',
        baseRef: 'main',
      }),
    );

    assert.equal(fs.existsSync(marker), true, 'teardownCmd should have run during rollback');
    assert.notEqual(
      fs.readFileSync(marker, 'utf8').trim(),
      '',
      'the real port, not a blank from a hardcoded null',
    );
  },
);

test('release tolerates a branch that is already gone', { concurrency: true }, async () => {
  const repoRoot = makeGitRepo();
  const res = await acquireResources({
    repoRoot,
    stateDir: tempStateDir(),
    id: '2026-08-04-a-branch-already-gone',
    baseRef: 'main',
  });
  await releaseResources({ repoRoot, ticket: { ...res, id: '2026-08-04-a-branch-already-gone' } });

  // Second call: nothing left to remove, and that is fine.
  await releaseResources({ repoRoot, ticket: { ...res, id: '2026-08-04-a-branch-already-gone' } });
});

// A failing teardownCmd used to stop the cleanup below it, so the ticket
// could never close and its worktree, branch and port were lost for good.
test(
  'a failing teardownCmd still removes the worktree, and still keeps the branch',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    writeDoc(isolationProfilePath(repoRoot), JSON.stringify({ teardownCmd: 'exit 1' }));
    const res = await acquireResources({
      repoRoot,
      stateDir: tempStateDir(),
      id: '2026-08-04-a-branch-already-gone-again',
      baseRef: 'main',
    });

    await releaseResources({
      repoRoot,
      ticket: { ...res, id: '2026-08-04-a-branch-already-gone-again' },
    });

    assert.equal(fs.existsSync(res.worktree!), false);
    assert.match(branches(repoRoot), /2026-08-04-a-branch-already-gone-again/);
  },
);

// A person can delete the worktree without closing the ticket. Node can not
// start a command in a missing folder, so release must fall back, not throw.
test(
  "release survives a worktree that's already gone before teardownCmd runs",
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    writeDoc(isolationProfilePath(repoRoot), JSON.stringify({ teardownCmd: 'true' }));
    const res = await acquireResources({
      repoRoot,
      stateDir: tempStateDir(),
      id: '2026-08-04-a-branch-already-gone-once-more',
      baseRef: 'main',
    });
    fs.rmSync(res.worktree!, { recursive: true, force: true });

    await releaseResources({
      repoRoot,
      ticket: { ...res, id: '2026-08-04-a-branch-already-gone-once-more' },
    });

    assert.match(branches(repoRoot), /2026-08-04-a-branch-already-gone-once-more/);
  },
);

// .env.glafka can hold a real password. Without the ignore line, `git add -A`
// would commit it and the push would send it to GitHub.
test(
  'the worktree ignores .env.glafka, committed so it starts clean',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const res = await acquireResources({
      repoRoot,
      stateDir: tempStateDir(),
      id: '2026-08-05-a-sandbox-that-cannot-start',
      baseRef: 'main',
    });

    const gitignore = fs.readFileSync(path.join(res.worktree!, '.gitignore'), 'utf8');
    assert.match(gitignore, /^\.env\.glafka$/m);

    const dirty = execFileSync('git', ['status', '--porcelain'], {
      cwd: res.worktree!,
      encoding: 'utf8',
    });
    assert.equal(dirty.trim(), '', 'worktree should start clean, with the ignore committed');
  },
);

// We let a port go as soon as we finish testing it, so a ticket's port really
// is free until its server starts. Two tickets could land on the same one.
test(
  'a port already promised to another open ticket is not handed out again',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const portRange = { start: 4771, end: 4772 };

    const first = await acquireResources({
      repoRoot,
      stateDir,
      id: '2026-08-04-port-claim-one',
      baseRef: 'main',
      portRange,
    });
    const now = new Date().toISOString();
    writeTicket(stateDir, {
      id: '2026-08-04-port-claim-one',
      branch: first.branch!,
      worktree: first.worktree!,
      port: first.port,
      isolationPorts: first.isolationPorts,
      specText: 'first',
      created: now,
      updated: now,
    });

    const second = await acquireResources({
      repoRoot,
      stateDir,
      id: '2026-08-04-port-claim-two',
      baseRef: 'main',
      portRange,
    });

    assert.notEqual(second.port, first.port, 'two open tickets were given the same port');
  },
);

// Setting up a ticket can take minutes, and until the ticket file is written
// its port looks free. The setup lock is what protects it in that gap.
test(
  'acquireResources refuses a port another ticket has only just claimed via its provisioning lock',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const single = { start: 4790, end: 4790 };
    writeProvisioningLock(stateDir, '2026-08-04-port-sweep-one', {
      branch: 'glafka/2026-08-04-port-sweep-one',
      ports: [4790],
    });

    await assert.rejects(
      () =>
        acquireResources({
          repoRoot,
          stateDir,
          id: '2026-08-04-port-sweep-two',
          baseRef: 'main',
          portRange: single,
        }),
      /no free port/,
    );
  },
);

// The other side of the test above. If the process died, its lock stays but
// its port was never really taken, so we must be able to use it again.
test(
  "acquireResources can claim a port a DEAD process's provisioning lock still names",
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const single = { start: 4791, end: 4791 };
    writeProvisioningLock(stateDir, '2026-08-04-port-sweep-four', {
      branch: 'glafka/2026-08-04-port-sweep-four',
      ports: [4791],
      pid: 999999, // no process on this machine has this pid
      startedAt: Date.now(),
    });

    const res = await acquireResources({
      repoRoot,
      stateDir,
      id: '2026-08-04-port-sweep-five',
      baseRef: 'main',
      portRange: single,
    });

    assert.equal(res.port, 4791);
  },
);

// Gathering the skip list, probing a port, and durably recording the claim used to
// be three separate moments. Two tickets provisioning at once could both read the skip list before either claim landed, both probe the same port, and both be told it was free. This proves the fix by holding the ports lock ourselves — a real second provision would be blocked exactly the same way, not racing past it.
test(
  'port selection waits out another provision holding the ports lock, rather than racing past it',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    const lockPath = portsLockPath(stateDir);
    const holdMs = 400;

    // Stands in for another ticket's own acquireResources call, mid-way
    // through picking a port.
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), {
      flag: 'wx',
    });
    setTimeout(() => fs.unlinkSync(lockPath), holdMs);

    const start = Date.now();
    const res = await acquireResources({
      repoRoot,
      stateDir,
      id: '2026-08-04-port-sweep-six',
      baseRef: 'main',
      portRange: { start: 4792, end: 4792 },
    });

    // It could only have finished this fast if it read the lock as free
    // and raced past the "other provision" instead of waiting for it.
    assert.ok(
      Date.now() - start >= holdMs - 50,
      'acquireResources must not claim a port before the lock is free',
    );
    assert.equal(res.port, 4792);
  },
);

// Same root cause as the findOrphans bug, smaller blast radius: a ticket file that fails
// to parse used to just vanish from assignedPorts' list, so its ports silently dropped out of the skip list and a NEW ticket could be handed a port a live ticket is still using. Provisioning must refuse instead of guessing on top of a list known to be incomplete.
test(
  'assignedPorts (via acquireResources) refuses to provision when a ticket file is unreadable',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();

    // A live ticket's own port, currently in use.
    writeTicket(stateDir, {
      id: '2026-08-04-port-claim-one',
      branch: 'glafka/2026-08-04-port-claim-one',
      worktree: path.join(repoRoot, '.worktrees', '2026-08-04-port-claim-one'),
      specText: 'x',
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      port: 4793,
    });

    // A second ticket's file, cut off mid-write — unreadable, not just missing.
    const cut = ticketFiles(ticketsDir(stateDir), '2026-08-04-port-claim-two');
    fs.mkdirSync(cut.dir, { recursive: true });
    fs.writeFileSync(cut.ticketFile, '{"id":"2026-08-04-port-claim-two","cont');

    await assert.rejects(
      () =>
        acquireResources({
          repoRoot,
          stateDir,
          id: '2026-08-04-port-claim-three',
          baseRef: 'main',
          portRange: { start: 4793, end: 4793 },
        }),
      /ticket file\(s\) could not be read/,
    );
  },
);

// onPortsClaimed must fire with the real ports early enough for the lock file
// to save them, before the slow setup steps start.
test(
  "acquireResources calls onPortsClaimed with the real ports the moment they're chosen",
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    writeDoc(isolationProfilePath(repoRoot), JSON.stringify(PROFILE));
    let claimed: number[] | null = null;

    const res = await acquireResources({
      repoRoot,
      stateDir: tempStateDir(),
      id: '2026-08-04-port-sweep-three',
      baseRef: 'main',
      onPortsClaimed: (ports) => {
        claimed = ports;
      },
    });

    assert.deepEqual(claimed!.slice().sort(), Object.values(res.isolationPorts!).sort());
  },
);

test(
  'acquireResources calls onPortsClaimed with the plain port for a services-less profile too',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    let claimed: number[] | null = null;

    const res = await acquireResources({
      repoRoot,
      stateDir: tempStateDir(),
      id: '2026-08-04-port-sweep-four',
      baseRef: 'main',
      onPortsClaimed: (ports) => {
        claimed = ports;
      },
    });

    assert.deepEqual(claimed, [res.port]);
  },
);

// isStaleProvisioningLock judges a lock against a single bootstrapTimeoutMs budget,
// measured from one fixed startedAt. That budget alone is smaller than bootstrapCmd + setupCmd + e2e.setupCmd combined, so a live, still-running provision could be declared stale partway through. `heartbeat` must fire before EACH long phase, so the caller can re-stamp the lock and give every phase its own fresh window.
test(
  'acquireResources calls heartbeat before bootstrapCmd and before each isolation hook',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    writeDoc(
      isolationProfilePath(repoRoot),
      JSON.stringify({
        workspace: { bootstrapCmd: 'true' },
        setupCmd: 'true',
        e2e: { setupCmd: 'true' },
      }),
    );
    let calls = 0;

    await acquireResources({
      repoRoot,
      stateDir: tempStateDir(),
      id: '2026-08-04-port-sweep-five',
      baseRef: 'main',
      heartbeat: () => {
        calls += 1;
      },
    });

    // Once before bootstrapCmd, once before setupCmd, once before e2e.setupCmd.
    assert.equal(calls, 3);
  },
);

test(
  'acquireResources never calls heartbeat when nothing long-running is configured',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    let calls = 0;

    await acquireResources({
      repoRoot,
      stateDir: tempStateDir(),
      id: '2026-08-04-port-sweep-six',
      baseRef: 'main',
      heartbeat: () => {
        calls += 1;
      },
    });

    assert.equal(calls, 0);
  },
);

// A closed ticket stops holding its port, with nothing to give back.
test("a closed ticket's port becomes available again", { concurrency: true }, async () => {
  const repoRoot = makeGitRepo();
  const stateDir = tempStateDir();
  const single = { start: 4781, end: 4781 };

  const first = await acquireResources({
    repoRoot,
    stateDir,
    id: '2026-08-04-a-closed-ticket-frees-its-port',
    baseRef: 'main',
    portRange: single,
  });
  const now = new Date().toISOString();
  writeTicket(stateDir, {
    id: '2026-08-04-a-closed-ticket-frees-its-port',
    branch: first.branch!,
    worktree: first.worktree!,
    port: first.port,
    specText: 'first',
    created: now,
    updated: now,
  });

  // Only one port in range, and it is taken, so a second ticket can not open.
  await assert.rejects(
    () =>
      acquireResources({
        repoRoot,
        stateDir,
        id: '2026-08-04-a-closed-ticket-frees-its-port-two',
        baseRef: 'main',
        portRange: single,
      }),
    /no free port/,
  );

  // Closing the first one frees it, with no release call at all.
  recordStage(stateDir, '2026-08-04-a-closed-ticket-frees-its-port', STAGES.LYSIS);
  const second = await acquireResources({
    repoRoot,
    stateDir,
    id: '2026-08-04-a-closed-ticket-frees-its-port-three',
    baseRef: 'main',
    portRange: single,
  });
  assert.equal(second.port, 4781);
});

// --------------------------------------------------------------------------- The project's own setup
// and teardown commands. ---------------------------------------------------------------------------

test('runIsolationHook exposes reserved ports as real shell env vars', () => {
  const output = runIsolationHook('echo "saw port $DB_PORT for $GLAFKA_TICKET_ID"', {
    cwd: process.cwd(),
    env: { DB_PORT: '6003', GLAFKA_TICKET_ID: '2026-08-07-add-dark-mode' },
  });

  assert.deepEqual(output, {});
});

test('runIsolationHook parses KEY=VALUE stdout lines into an object', () => {
  const output = runIsolationHook(
    'echo "DATABASE_URL=postgresql://user:pass@localhost:$DB_PORT/mydb"',
    { cwd: process.cwd(), env: { DB_PORT: '6003' } },
  );

  assert.deepEqual(output, { DATABASE_URL: 'postgresql://user:pass@localhost:6003/mydb' });
});

test("runIsolationHook ignores stdout lines that aren't KEY=VALUE", () => {
  const output = runIsolationHook('echo "provisioning done" && echo "FOO=bar"', {
    cwd: process.cwd(),
    env: {},
  });

  assert.deepEqual(output, { FOO: 'bar' });
});

test('runIsolationHook throws when the command fails', () => {
  assert.throws(() => runIsolationHook('exit 1', { cwd: process.cwd(), env: {} }));
});

// --------------------------------------------------------------------------- Picking ports.
// ---------------------------------------------------------------------------

// Really holds a port for the test, so "in use" means truly in use,
// not just a note in a file we wrote.
function occupy(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({ port, host: '0.0.0.0', exclusive: true }, () => resolve(server));
  });
}

function close(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

test('findFreePort returns a port inside the requested range', { concurrency: true }, async () => {
  const range = { start: 4400, end: 4409 };

  const port = await findFreePort(range);

  assert.ok(Number.isInteger(port));
  assert.ok(port >= range.start && port <= range.end, `${port} outside the range`);
});

// The answer comes from the operating system, not from our own notes.
// A port really in use is never handed out, even if we never wrote it down.
test(
  'a port genuinely in use is never returned, though glafka never recorded it',
  { concurrency: true },
  async () => {
    const single = { start: 4410, end: 4410 };
    const server = await occupy(4410);
    try {
      await assert.rejects(() => findFreePort(single), /no free port in 4410-4410/);
    } finally {
      await close(server);
    }

    // It is free again as soon as the holder lets go. Nothing to clean up.
    assert.equal(await findFreePort(single), 4410);
  },
);

test(
  'an occupied port is stepped over in favour of a free one',
  { concurrency: true },
  async () => {
    const range = { start: 4420, end: 4421 };
    const server = await occupy(4420);
    try {
      assert.equal(await findFreePort(range), 4421);
    } finally {
      await close(server);
    }
  },
);

// In one ticket we pick several ports at once, and none is in use yet.
// `skip` is what stops two services getting the same number.
test(
  'skip prevents handing out a port already chosen in this same pass',
  { concurrency: true },
  async () => {
    const range = { start: 4430, end: 4431 };

    const first = await findFreePort(range);
    const second = await findFreePort(range, { skip: [first] });

    assert.notEqual(first, second);
    assert.deepEqual([first, second].sort(), [4430, 4431]);
  },
);

test(
  'an exhausted range fails with a message naming the range and the fix',
  { concurrency: true },
  async () => {
    const range = { start: 4440, end: 4441 };

    await assert.rejects(
      () => findFreePort(range, { skip: [4440, 4441] }),
      (err: Error) => {
        assert.match(err.message, /no free port in 4440-4441/);
        assert.match(err.message, /portRange in \.glafka\.json/);
        return true;
      },
    );
  },
);

// Two runs close together would try the same ports in the same order.
// Starting at a random spot spreads them out.
test(
  'repeated calls over a wide range do not all return the same port',
  { concurrency: true },
  async () => {
    const range = { start: 4500, end: 4599 };

    const seen = new Set();
    for (let i = 0; i < 12; i++) seen.add(await findFreePort(range));

    assert.ok(seen.size > 1, `every call returned the same port: ${[...seen]}`);
  },
);

// Testing only 127.0.0.1 would call a port free while a server listens on
// every address. That is exactly the clash we want to stop.
test('a port bound on all interfaces counts as in use', { concurrency: true }, async () => {
  const single = { start: 4460, end: 4460 };
  const server = await occupy(4460);
  try {
    await assert.rejects(() => findFreePort(single));
  } finally {
    await close(server);
  }
});

test(
  "a ticket's worktree gets its submodules populated, not left as empty dirs",
  { concurrency: true },
  async () => {
    const { repoRoot } = makeRepoWithSubmodule();
    const stateDir = makeTempDir('state');

    const { worktree } = await withFileProtocol(() =>
      acquireResources({
        repoRoot,
        stateDir,
        id: '2026-08-04-a-port-bound-on-all-interfaces',
        baseRef: 'main',
      }),
    );

    // Without submodule work this file is missing and the build fails.
    assert.equal(fs.existsSync(path.join(worktree, 'packages/real', 'README.md')), true);
  },
);

test('a workspace-only profile still gets a plain PORT', { concurrency: true }, async () => {
  // A repo can need submodules and still run on one plain port.
  // This used to hand back no port at all.
  const { repoRoot } = makeRepoWithSubmodule();
  const stateDir = makeTempDir('state');
  writeDoc(isolationProfilePath(repoRoot), JSON.stringify({ workspace: { bootstrapCmd: 'true' } }));

  const { worktree, port } = await withFileProtocol(() =>
    acquireResources({
      repoRoot,
      stateDir,
      id: '2026-08-04-a-workspace-only-profile',
      baseRef: 'main',
    }),
  );

  assert.ok(Number.isInteger(port), 'expected a real port');
  assert.equal(envOf(worktree).PORT, String(port));
});

test(
  'seedFiles copies gitignored local files the worktree would otherwise never get',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = makeTempDir('state');
    fs.writeFileSync(path.join(repoRoot, '.env'), 'LOCAL_ONLY=1\n');
    writeDoc(
      isolationProfilePath(repoRoot),
      JSON.stringify({ workspace: { seedFiles: ['.env'] } }),
    );

    const { worktree } = await acquireResources({
      repoRoot,
      stateDir,
      id: '2026-08-04-a-workspace-only-profile-two',
      baseRef: 'main',
    });

    assert.equal(fs.readFileSync(path.join(worktree, '.env'), 'utf8'), 'LOCAL_ONLY=1\n');
  },
);

test(
  "seedFiles skips a path the main checkout doesn't have, instead of failing the ticket",
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = makeTempDir('state');
    writeDoc(
      isolationProfilePath(repoRoot),
      JSON.stringify({ workspace: { seedFiles: ['.env', 'nope/.env'] } }),
    );

    const { worktree } = await acquireResources({
      repoRoot,
      stateDir,
      id: '2026-08-04-a-workspace-only-profile-three',
      baseRef: 'main',
    });

    assert.equal(fs.existsSync(path.join(worktree, 'nope/.env')), false);
  },
);

test(
  'bootstrapCmd runs in the worktree and its stdout never leaks into .env.glafka',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = makeTempDir('state');
    writeDoc(
      isolationProfilePath(repoRoot),
      JSON.stringify({
        // Package managers really do print KEY=VALUE lines. If we read this
        // output like a hook's, all of them would land in the ticket's env.
        workspace: { bootstrapCmd: 'echo INSTALLED=yes && echo done > bootstrap-ran.txt' },
      }),
    );

    const { worktree } = await acquireResources({
      repoRoot,
      stateDir,
      id: '2026-08-04-a-workspace-only-profile-four',
      baseRef: 'main',
    });

    assert.equal(
      fs.existsSync(path.join(worktree, 'bootstrap-ran.txt')),
      true,
      'bootstrap should run',
    );
    assert.equal(
      envOf(worktree).INSTALLED,
      undefined,
      'bootstrap stdout must not be parsed as env',
    );
  },
);

test(
  "bootstrap sees the main checkout's path, so it can reach uncommitted files",
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = makeTempDir('state');
    writeDoc(
      isolationProfilePath(repoRoot),
      JSON.stringify({ workspace: { bootstrapCmd: 'echo "$GLAFKA_REPO_ROOT" > where.txt' } }),
    );

    const { worktree } = await acquireResources({
      repoRoot,
      stateDir,
      id: '2026-08-04-a-workspace-only-profile-five',
      baseRef: 'main',
    });

    assert.equal(fs.readFileSync(path.join(worktree, 'where.txt'), 'utf8').trim(), repoRoot);
  },
);

test(
  'a failing bootstrap tears the worktree down instead of leaving a half-built ticket',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = makeTempDir('state');
    writeDoc(
      isolationProfilePath(repoRoot),
      JSON.stringify({ workspace: { bootstrapCmd: 'exit 3' } }),
    );

    await assert.rejects(() =>
      acquireResources({
        repoRoot,
        stateDir,
        id: '2026-08-04-a-workspace-only-profile-six',
        baseRef: 'main',
      }),
    );

    const worktrees = execFileSync('git', ['worktree', 'list'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert.equal(
      worktrees.includes('2026-08-04-a-workspace-only-profile-six'),
      false,
      'the worktree should be gone',
    );
  },
);

// --------------------------------------------------------------------------- Hook limits: how much
// it can print, and how long it can run ---------------------------------------------------------------------------

// A big install prints more than Node's 1 MB limit, and past it Node kills
// the child. The whole ticket then rolled back with a confusing error.
test('runIsolationHook survives a hook that prints past 1MB, and still reads its KEY=VALUE', () => {
  const output = runIsolationHook(
    // We build the newline in code. The text passes through three layers,
    // and each one would eat a backslash.
    `node -e "process.stdout.write('x'.repeat(2 * 1024 * 1024) + String.fromCharCode(10))" && echo "FOO=bar"`,
    { cwd: process.cwd(), env: {} },
  );

  assert.deepEqual(output, { FOO: 'bar' });
});

test('runBootstrap survives a bootstrap that prints past 1MB', () => {
  assert.doesNotThrow(() =>
    runBootstrap(`node -e "process.stdout.write('x'.repeat(2 * 1024 * 1024))"`, {
      cwd: process.cwd(),
      env: {},
    }),
  );
});

// These hooks used to run with no time limit. A setup or teardown that hung
// then hung the whole command, and nothing could close the ticket.
test('runIsolationHook honours a timeout instead of hanging forever', () => {
  assert.throws(
    () => runIsolationHook('sleep 30', { cwd: process.cwd(), env: {}, timeout: 300 }),
    (err: NodeJS.ErrnoException & { killed?: boolean }) =>
      err.code === 'ETIMEDOUT' || err.killed === true,
  );
});

test(
  'releaseResources passes its budget through to the teardown hook',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    writeDoc(isolationProfilePath(repoRoot), JSON.stringify({ teardownCmd: 'sleep 30' }));
    const res = await acquireResources({
      repoRoot,
      stateDir: tempStateDir(),
      id: '2026-08-04-a-hook-that-hangs',
      baseRef: 'main',
    });

    // A hung teardownCmd must not block cleanup. If the time limit really
    // reached the hook, this finishes fast instead of waiting 30 seconds.
    const start = Date.now();
    await releaseResources({
      repoRoot,
      ticket: { id: '2026-08-04-a-hook-that-hangs', branch: res.branch!, worktree: res.worktree! },
      isolationHookTimeoutMs: 300,
    });
    assert.ok(
      Date.now() - start < 5000,
      'releaseResources should not wait out the hung teardownCmd',
    );
  },
);

// Some commands pass no time limit at all, and that used to mean "wait
// forever". The default must be a real number above zero.
test('the isolation-hook budget has a real default for callers that pass none', () => {
  assert.equal(typeof DEFAULT_ISOLATION_HOOK_TIMEOUT_MS, 'number');
  assert.ok(DEFAULT_ISOLATION_HOOK_TIMEOUT_MS > 0);
});

// --------------------------------------------------------------------------- A worktree only holds
// committed files. A hook file that was never committed leaves the ticket uncaged, so we warn loudly about it here. ---------------------------------------------------------------------------

test(
  'acquireResources warns when a hook config repoRoot has is missing from the new worktree',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    // On disk, but never committed. Same as a half-finished install.
    fs.mkdirSync(path.join(repoRoot, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, '.claude', 'settings.json'), '{}\n');

    const messages: string[] = [];
    const originalError = console.error;
    console.error = (msg) => messages.push(msg);
    try {
      await acquireResources({
        repoRoot,
        stateDir: tempStateDir(),
        id: '2026-08-04-the-default-hook-budget',
        baseRef: 'main',
      });
    } finally {
      console.error = originalError;
    }

    assert.ok(
      messages.some((m) => m.includes('.claude/settings.json') && m.includes('uncaged')),
      `expected a loud warning naming the missing file, got: ${JSON.stringify(messages)}`,
    );
  },
);

test(
  'acquireResources warns for none of it when no hook config is installed at all',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();

    const messages: string[] = [];
    const originalError = console.error;
    console.error = (msg) => messages.push(msg);
    try {
      await acquireResources({
        repoRoot,
        stateDir: tempStateDir(),
        id: '2026-08-04-the-default-hook-budget-two',
        baseRef: 'main',
      });
    } finally {
      console.error = originalError;
    }

    assert.deepEqual(messages, [], 'an ordinary repo with no hook installed at all must not warn');
  },
);

test(
  'acquireResources stays silent when the hook config is committed and reaches the worktree normally',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    fs.mkdirSync(path.join(repoRoot, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, '.claude', 'settings.json'), '{}\n');
    execFileSync('git', ['add', '.claude/settings.json'], { cwd: repoRoot });
    execFileSync('git', ['commit', '-q', '-m', 'install hook'], { cwd: repoRoot });

    const messages: string[] = [];
    const originalError = console.error;
    console.error = (msg) => messages.push(msg);
    try {
      const { worktree } = await acquireResources({
        repoRoot,
        stateDir: tempStateDir(),
        id: '2026-08-04-the-default-hook-budget-three',
        baseRef: 'main',
      });
      assert.equal(fs.existsSync(path.join(worktree, '.claude', 'settings.json')), true);
    } finally {
      console.error = originalError;
    }

    assert.deepEqual(messages, [], 'the ordinary caged case must not warn');
  },
);

// buildBranchName used to read the clock, so provisionTicket (which records the name)
// and acquireResources (which creates the branch) could disagree across midnight — epistle then pushed a branch that did not exist while findOrphans force-deleted the one that did. The clock is gone, but the recorded name still has to win over anything recomputed, so the override stays pinned.
test('acquireResources uses the branch name it was given, not a fresh one', async () => {
  const repoRoot = makeTempDir('branch31');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.email', 'x@y.z'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.name', 'x'], { cwd: repoRoot });
  fs.writeFileSync(path.join(repoRoot, 'a.txt'), 'a');
  execFileSync('git', ['add', '-A'], { cwd: repoRoot });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: repoRoot });

  const stateDir = path.join(repoRoot, '.glafka');
  fs.mkdirSync(stateDir, { recursive: true });

  // A name no clock would ever produce, so only the passed-in one can win.
  const branch = 'glafka/1999-01-01-decided-once';
  const acquired = await acquireResources({
    repoRoot,
    stateDir,
    id: '2026-08-07-add-search-filters',
    baseRef: 'main',
    branch,
  });

  assert.equal(acquired.branch, branch);
  assert.equal(
    execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: acquired.worktree,
      encoding: 'utf8',
    }).trim(),
    branch,
    'the checkout must be on the name that was recorded',
  );

  fs.rmSync(repoRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

// The agent's TMPDIR sits outside the repo, named by ticket id. Nothing
// removed it, so a hundred closed tickets left a hundred folders behind.
test('releaseResources removes the ticket scratch directory spawnBackground made', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = path.join(repoRoot, '.glafka');
  fs.mkdirSync(stateDir, { recursive: true });

  const id = '2026-08-04-scratch-removed-on-release';
  const acquired = await acquireResources({ repoRoot, stateDir, id, baseRef: 'main' });

  spawnBackground({ stateDir, id, agentCmd: 'true', prompt: 'hi', cwd: acquired.worktree });
  const scratch = ticketScratchPath(id);
  assert.equal(fs.existsSync(scratch), true, 'spawnBackground must have made it');
  // Something inside it, so this is not passing on an empty-directory technicality.
  fs.writeFileSync(path.join(scratch, 'model-scratch.txt'), 'x'.repeat(1024));

  await releaseResources({
    repoRoot,
    ticket: { id, branch: acquired.branch, worktree: acquired.worktree },
    profile: null,
  });

  assert.equal(fs.existsSync(scratch), false, 'closing the ticket must remove it');
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

// createWorktree sat ABOVE the try that cleans up, so a throw from the branch
// check or the profile read leaked the whole checkout and its branch.
test('a malformed isolation profile leaves no worktree and no branch behind', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = path.join(repoRoot, '.glafka');
  fs.mkdirSync(stateDir, { recursive: true });

  // Valid JSON, wrong shape — so JSON.parse succeeds and the schema check is what fails.
  writeDoc(isolationProfilePath(repoRoot), JSON.stringify({ services: 'not-an-array' }));

  const id = '2026-08-04-a-malformed-isolation-profile';
  await assert.rejects(() => acquireResources({ repoRoot, stateDir, id, baseRef: 'main' }));

  const worktrees = execFileSync('git', ['worktree', 'list'], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(worktrees.includes('.worktrees'), false, 'no worktree may survive the failure');
  const branches = execFileSync('git', ['branch', '--list', 'glafka/*'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
  assert.equal(branches, '', 'no branch may survive the failure');

  fs.rmSync(repoRoot, { recursive: true, force: true });
});

// Found while proving the test above: releaseResources re-read the bad profile and threw on
// its first line, so cleanup did nothing and no ticket could be closed at all.
test('a ticket still closes when the isolation profile cannot be read', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = path.join(repoRoot, '.glafka');
  fs.mkdirSync(stateDir, { recursive: true });

  const id = '2026-08-04-an-unreadable-isolation-profile';
  const acquired = await acquireResources({ repoRoot, stateDir, id, baseRef: 'main' });

  // Broken only AFTER the ticket exists, which is the case lysis and cancel hit.
  writeDoc(isolationProfilePath(repoRoot), JSON.stringify({ services: 'not-an-array' }));

  await releaseResources({
    repoRoot,
    ticket: { id, branch: acquired.branch, worktree: acquired.worktree },
  });

  assert.equal(fs.existsSync(acquired.worktree), false, 'the worktree must still be removed');
  const branches = execFileSync('git', ['branch', '--list', 'glafka/*'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
  assert.match(
    branches,
    /2026-08-04-an-unreadable-isolation-profile/,
    'the branch must still be kept',
  );

  fs.rmSync(repoRoot, { recursive: true, force: true });
});

// Every run's prompt and log stayed under .glafka/runs/<id>/ for good. Found by
// diffing a real lifecycle, not by reading: grep sees no missing rmSync here.
test('archiving a closed ticket removes its run logs', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = path.join(repoRoot, '.glafka');
  fs.mkdirSync(stateDir, { recursive: true });

  const id = '2026-08-04-archiving-removes-run-logs';
  const acquired = await acquireResources({ repoRoot, stateDir, id, baseRef: 'main' });
  writeTicket(stateDir, {
    id,
    title: null,
    branch: acquired.branch,
    worktree: acquired.worktree,
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
  });
  recordStage(stateDir, id, STAGES.CREATE);

  spawnBackground({ stateDir, id, agentCmd: 'true', prompt: 'hi', cwd: acquired.worktree });
  const runs = runsDir(stateDir, id);
  assert.equal(fs.existsSync(runs), true, 'the run must have made its folder');

  // The spawn is detached and keeps writing pid, log and exit-code for a moment. Archiving
  // underneath it raced the delete and threw ENOTEMPTY roughly one run in three. The retry
  // added to archiveClosedTicket covers the real case; the test should not need it.
  const { exitCodePath } = runFiles(stateDir, id);
  const deadline = Date.now() + 60000;
  while (!fs.existsSync(exitCodePath) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  archiveClosedTicket(stateDir, id);

  assert.equal(fs.existsSync(runs), false, 'closing the ticket must take its run logs with it');
  // The archive itself must still be there — this removes logs, not history.
  assert.equal(
    fs.existsSync(ticketFiles(closedTicketsDir(stateDir), id).ticketFile),
    true,
    'the ticket must still be archived',
  );

  fs.rmSync(repoRoot, { recursive: true, force: true });
});

// The rollback path is the only one that still deletes a branch, so the guard
// against swallowing a real git error as "already gone" has to live here now.
test('setup rollback surfaces a real branch-delete failure', { concurrency: true }, async () => {
  const repoRoot = makeGitRepo();
  const res = await acquireResources({
    repoRoot,
    stateDir: tempStateDir(),
    id: '2026-08-04-a-branch-delete-that-fails',
    baseRef: 'main',
  });

  // A stale lock, as a crashed git process leaves behind. Delete fails with
  // "cannot lock ref", which is not the same as the branch being gone.
  const lockPath = path.join(repoRoot, '.git', 'refs', 'heads', `${res.branch!}.lock`);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, '');

  assert.throws(
    () =>
      releaseGitResources({
        repoRoot,
        ticket: {
          id: '2026-08-04-a-branch-delete-that-fails',
          branch: res.branch!,
          worktree: res.worktree!,
        },
        discardBranch: true,
      }),
    (err: Error) => /cannot lock ref/i.test(err.message) && !/not found/i.test(err.message),
  );
});
