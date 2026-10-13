import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeGitRepo } from '../helpers/gitFixture.js';
import { genesis } from '../../src/commands/genesis/genesis.js';
import { readTicket, isActive } from '../../src/ticket/ticketStore.js';
import { currentBranch } from '../../src/util/git.js';
import { readDoc, isolationProfilePath, writeDoc } from '../../src/memory/docsStore.js';
import { headCommit } from '../../src/util/git.js';
import { makeTempDir } from '../helpers/tempDir.js';

function envVar(worktree: string, name: string) {
  const content = fs.readFileSync(path.join(worktree, '.env.glafka'), 'utf8');
  const line = content.split('\n').find((l) => l.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1) : undefined;
}

function tempStateDir() {
  return makeTempDir('state');
}

test(
  'genesis creates a worktree, a branch, and a live ticket file',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();

    const ticket = await genesis({ repoRoot, stateDir, content: 'fix the login bug' });

    // The ticket must be "live". Both the port picker and orphan cleanup check this.
    assert.equal(isActive(ticket), true);
    assert.equal(ticket.branch!, `glafka/${ticket.id}`);
    assert.equal(fs.existsSync(ticket.worktree!), true);
    assert.equal(currentBranch(ticket.worktree!), ticket.branch!);

    const loaded = readTicket(stateDir, ticket.id);
    assert.equal(loaded.specText, 'fix the login bug');
  },
);

test(
  'genesis puts the worktree in its own top-level .worktrees/, not inside .glafka/',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();

    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });

    assert.equal(ticket.worktree!, path.join(repoRoot, '.worktrees', ticket.id));
  },
);

test(
  'genesis always persists the spec permanently under docs/glafka/tickets/<id>/spec.md',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();

    const ticket = await genesis({ repoRoot, stateDir, content: 'fix the login bug' });

    assert.equal(ticket.specPath, path.join(repoRoot, 'docs/glafka/tickets', ticket.id, 'spec.md'));
    assert.equal(readDoc(ticket.specPath), 'fix the login bug');
    assert.equal(readTicket(stateDir, ticket.id).specPath, ticket.specPath);
  },
);

test(
  'genesis leaves planPath null when no plan content is given',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();

    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });

    assert.equal(ticket.planPath, null);
  },
);

test(
  'genesis persists plan content under docs/glafka/tickets/<id>/plan.md when given',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();

    const ticket = await genesis({
      repoRoot,
      stateDir,
      content: 'task',
      planContent: '1. do the thing',
    });

    assert.equal(ticket.planPath, path.join(repoRoot, 'docs/glafka/tickets', ticket.id, 'plan.md'));
    assert.equal(readDoc(ticket.planPath), '1. do the thing');
    assert.equal(readTicket(stateDir, ticket.id).planPath, ticket.planPath);
  },
);

test(
  "genesis reserves a port and writes it into the worktree's .env.glafka",
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();

    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });

    assert.equal(typeof ticket.port, 'number');
    // GLAFKA_TICKET_ID is always written, even with no isolation setup.
    const envContent = fs.readFileSync(path.join(ticket.worktree!, '.env.glafka'), 'utf8');
    assert.equal(envContent, `PORT=${ticket.port}\nGLAFKA_TICKET_ID=${ticket.id}\n`);
  },
);

test('genesis respects a configured port range', { concurrency: true }, async () => {
  const repoRoot = makeGitRepo();
  const stateDir = tempStateDir();

  const ticket = await genesis({
    repoRoot,
    stateDir,
    content: 'task',
    portRange: { start: 9000, end: 9000 },
  });

  assert.equal(ticket.port, 9000);
});

test('genesis gives two tickets different ports', { concurrency: true }, async () => {
  const repoRoot = makeGitRepo();
  const stateDir = tempStateDir();

  const a = await genesis({ repoRoot, stateDir, content: 'task a' });
  const b = await genesis({ repoRoot, stateDir, content: 'task b' });

  assert.notEqual(a.port, b.port);
});

test(
  "genesis uses this project's isolation profile when odysse has discovered one",
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    writeDoc(
      isolationProfilePath(repoRoot),
      JSON.stringify({
        services: [
          { name: 'ui', envVars: ['UI_PORT'] },
          { name: 'backend', envVars: ['PORT', 'SERVER_PORT'] },
        ],
      }),
    );

    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });

    assert.equal(ticket.port, null);
    assert.deepEqual(Object.keys(ticket.isolationPorts!), ['ui', 'backend']);
    const uiPort = envVar(ticket.worktree!, 'UI_PORT');
    const port = envVar(ticket.worktree!, 'PORT');
    const serverPort = envVar(ticket.worktree!, 'SERVER_PORT');
    assert.ok(uiPort);
    assert.equal(port, serverPort); // same service, same port
    assert.notEqual(uiPort, port);
    assert.equal(envVar(ticket.worktree!, 'GLAFKA_TICKET_ID'), ticket.id);
  },
);

test(
  "genesis runs the profile's setupCmd with reserved ports as real env vars",
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    writeDoc(
      isolationProfilePath(repoRoot),
      JSON.stringify({
        services: [{ name: 'db', envVars: ['DB_PORT'] }],
        setupCmd: 'echo "DATABASE_URL=postgresql://user:pass@localhost:$DB_PORT/mydb"',
      }),
    );

    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });

    const dbPort = envVar(ticket.worktree!, 'DB_PORT');
    assert.equal(
      envVar(ticket.worktree!, 'DATABASE_URL'),
      `postgresql://user:pass@localhost:${dbPort}/mydb`,
    );
  },
);

test(
  "genesis also provisions the profile's e2e services and setupCmd",
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    writeDoc(
      isolationProfilePath(repoRoot),
      JSON.stringify({
        services: [{ name: 'db', envVars: ['DB_PORT'] }],
        e2e: {
          services: [{ name: 'e2e-db', envVars: ['E2E_DB_PORT'] }],
          setupCmd: 'echo "E2E_DATABASE_URL=postgresql://localhost:$E2E_DB_PORT/e2e"',
        },
      }),
    );

    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });

    assert.deepEqual(Object.keys(ticket.isolationPorts!), ['db', 'e2e-db']);
    const e2ePort = envVar(ticket.worktree!, 'E2E_DB_PORT');
    assert.ok(e2ePort);
    assert.equal(
      envVar(ticket.worktree!, 'E2E_DATABASE_URL'),
      `postgresql://localhost:${e2ePort}/e2e`,
    );
  },
);

test(
  'genesis without an isolation profile still falls back to the plain single port',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();

    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });

    assert.equal(typeof ticket.port, 'number');
    assert.equal(ticket.isolationPorts, null);
  },
);

test(
  'genesis captures the planned commit only when a plan is given',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();

    const withPlan = await genesis({
      repoRoot,
      stateDir,
      content: 'task',
      planContent: '1. do it',
    });
    assert.equal(withPlan.planCommit, headCommit(withPlan.worktree!));

    const withoutPlan = await genesis({ repoRoot, stateDir, content: 'task 2' });
    assert.equal(withoutPlan.planCommit, null);
  },
);

test('genesis gitignores .env.glafka inside the new worktree', { concurrency: true }, async () => {
  const repoRoot = makeGitRepo();
  const stateDir = tempStateDir();

  const ticket = await genesis({ repoRoot, stateDir, content: 'task' });

  const gitignore = fs.readFileSync(path.join(ticket.worktree!, '.gitignore'), 'utf8');
  assert.match(gitignore, /^\.env\.glafka$/m);
  const status = execFileSync('git', ['status', '--porcelain', '--ignored', '.env.glafka'], {
    cwd: ticket.worktree!,
    encoding: 'utf8',
  });
  assert.match(status.trim(), /^!! \.env\.glafka$/);
});

test(
  'genesis appends to an existing .gitignore instead of clobbering it',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'node_modules/\n');
    execFileSync('git', ['add', '.gitignore'], { cwd: repoRoot });
    execFileSync('git', ['commit', '-q', '-m', 'add gitignore'], { cwd: repoRoot });
    const stateDir = tempStateDir();

    const ticket = await genesis({ repoRoot, stateDir, content: 'task' });

    const gitignore = fs.readFileSync(path.join(ticket.worktree!, '.gitignore'), 'utf8');
    assert.match(gitignore, /node_modules\//);
    assert.match(gitignore, /\.env\.glafka/);
  },
);

test(
  'genesis rolls back the worktree and branch when a later step fails',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    writeDoc(
      isolationProfilePath(repoRoot),
      JSON.stringify({
        services: [{ name: 'db', envVars: ['DB_PORT'] }],
        setupCmd: 'exit 1', // fails on purpose, after ports were picked
      }),
    );
    const stateDir = tempStateDir();

    await assert.rejects(() => genesis({ repoRoot, stateDir, content: 'task' }));

    const worktrees = fs.existsSync(path.join(repoRoot, '.worktrees'))
      ? fs.readdirSync(path.join(repoRoot, '.worktrees'))
      : [];
    assert.deepEqual(worktrees, []);
    const branches = execFileSync('git', ['branch', '--list', 'glafka/*'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert.equal(branches.trim(), '');
    // No port stays marked as "taken", so we only need to check worktree and branch.
  },
);

// This lock stops `lysis --sweep`, if run at the same time, from seeing
// this ticket's half-made worktree as an orphan.
test(
  'genesis writes a provisioning lock before acquiring resources, and removes it once done',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();

    const pending = genesis({ repoRoot, stateDir, content: 'task' });

    // The lock file is written before the first await, so it exists right away.
    const ticketsDirPath = path.join(stateDir, 'tickets');
    const locksWhilePending = fs.existsSync(ticketsDirPath)
      ? fs.readdirSync(ticketsDirPath).filter((n) => n.endsWith('.provisioning'))
      : [];
    assert.equal(locksWhilePending.length, 1);

    const ticket = await pending;

    assert.equal(locksWhilePending[0], `${ticket.id}.provisioning`);
    assert.equal(fs.existsSync(path.join(ticketsDirPath, locksWhilePending[0])), false);
  },
);

test(
  'genesis removes the provisioning lock even when a later step fails',
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
    const stateDir = tempStateDir();

    await assert.rejects(() => genesis({ repoRoot, stateDir, content: 'task' }));

    const ticketsDirPath = path.join(stateDir, 'tickets');
    const locks = fs.existsSync(ticketsDirPath)
      ? fs.readdirSync(ticketsDirPath).filter((n) => n.endsWith('.provisioning'))
      : [];
    assert.deepEqual(locks, []);
  },
);

test(
  'genesis rolls back a worktree that already carries a commit',
  { concurrency: true },
  async () => {
    const repoRoot = makeGitRepo();
    const stateDir = tempStateDir();
    // Make the spec write fail: create "docs/glafka/tickets" as a file,
    // not a folder, so writeDoc cannot make the ticket's folder inside it.
    fs.mkdirSync(path.join(repoRoot, 'docs', 'glafka'), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, 'docs', 'glafka', 'tickets'),
      'this is a file, not a dir\n',
    );

    await assert.rejects(() => genesis({ repoRoot, stateDir, content: 'task' }));

    // This fails right after the .gitignore commit, so rollback must
    // remove a worktree/branch that already has a commit on it.
    const worktrees = fs.existsSync(path.join(repoRoot, '.worktrees'))
      ? fs.readdirSync(path.join(repoRoot, '.worktrees'))
      : [];
    assert.deepEqual(worktrees, []);
    const branches = execFileSync('git', ['branch', '--list', 'glafka/*'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert.equal(branches.trim(), '');
  },
);
