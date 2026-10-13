import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeTempDir } from '../helpers/tempDir.js';
import {
  makeGitRepo,
  addBareRemote,
  makeRepoWithSubmodule,
  withFileProtocol,
} from '../helpers/gitFixture.js';
import {
  commitFile,
  createWorktree,
  removeWorktree,
  hasUncommittedChanges,
  branchDiff,
  boundedDiff,
  changedFiles,
  currentBranch,
  headCommit,
  rebaseOnto,
  commitsSince,
  latestCommitMessage,
  ticketCommitMessages,
  ticketCommits,
  commitPaths,
  diffStat,
  detectBaseRef,
  refExists,
  listGitlinks,
  initSubmodules,
  checkoutBranchIn,
  worktreeCheckKey,
  push,
  PushRejectedError,
} from '../../src/util/git.js';

// Make a brand new empty folder each time.
// `git worktree add` fails if the folder already exists.
function freshWorktreeDir() {
  const parent = makeTempDir('wt');
  return path.join(parent, 'wt');
}

test('createWorktree checks out a new branch into a new directory', { concurrency: true }, () => {
  const repoRoot = makeGitRepo();
  const worktreeDir = freshWorktreeDir();

  createWorktree(repoRoot, {
    branch: 'glafka/2026-08-07-add-dark-mode',
    worktreeDir,
    baseRef: 'main',
  });

  assert.equal(fs.existsSync(path.join(worktreeDir, 'README.md')), true);
  assert.equal(currentBranch(worktreeDir), 'glafka/2026-08-07-add-dark-mode');
});

test('hasUncommittedChanges reflects the working tree state', { concurrency: true }, () => {
  const repoRoot = makeGitRepo();
  const worktreeDir = freshWorktreeDir();
  createWorktree(repoRoot, {
    branch: 'glafka/2026-08-01-uncommitted-changes',
    worktreeDir,
    baseRef: 'main',
  });

  assert.equal(hasUncommittedChanges(worktreeDir), false);

  fs.writeFileSync(path.join(worktreeDir, 'new-file.txt'), 'hi\n');
  assert.equal(hasUncommittedChanges(worktreeDir), true);
});

test('removeWorktree deletes a clean worktree directory', { concurrency: true }, () => {
  const repoRoot = makeGitRepo();
  const worktreeDir = freshWorktreeDir();
  createWorktree(repoRoot, {
    branch: 'glafka/2026-08-01-remove-a-clean-worktree',
    worktreeDir,
    baseRef: 'main',
  });

  removeWorktree(repoRoot, worktreeDir);

  assert.equal(fs.existsSync(worktreeDir), false);
});

test(
  'branchDiff returns what a branch actually changed vs. its base',
  { concurrency: true },
  () => {
    const repoRoot = makeGitRepo();
    const worktreeDir = freshWorktreeDir();
    createWorktree(repoRoot, {
      branch: 'glafka/2026-08-01-remove-a-clean-worktree-two',
      worktreeDir,
      baseRef: 'main',
    });

    fs.writeFileSync(path.join(worktreeDir, 'shipped.txt'), 'final version\n');
    execFileSync('git', ['add', 'shipped.txt'], { cwd: worktreeDir });
    execFileSync('git', ['commit', '-q', '-m', 'ship it'], { cwd: worktreeDir });

    const diff = branchDiff(worktreeDir, 'main');

    assert.match(diff, /shipped\.txt/);
    assert.match(diff, /\+final version/);
  },
);

test(
  'changedFiles lists just the paths a branch touched vs. its base',
  { concurrency: true },
  () => {
    const repoRoot = makeGitRepo();
    const worktreeDir = freshWorktreeDir();
    createWorktree(repoRoot, {
      branch: 'glafka/2026-08-01-remove-a-clean-worktree-three',
      worktreeDir,
      baseRef: 'main',
    });

    fs.mkdirSync(path.join(worktreeDir, 'src'));
    fs.writeFileSync(path.join(worktreeDir, 'src', 'a.js'), 'a\n');
    fs.writeFileSync(path.join(worktreeDir, 'b.js'), 'b\n');
    execFileSync('git', ['add', 'src/a.js', 'b.js'], { cwd: worktreeDir });
    execFileSync('git', ['commit', '-q', '-m', 'add files'], { cwd: worktreeDir });

    const files = changedFiles(worktreeDir, 'main');

    assert.deepEqual(files.sort(), ['b.js', path.join('src', 'a.js')].sort());
  },
);

// Bounding per FILE does not bound the total — enough files and the prompt is oversized anyway,
// and then it is oversized identically on every retry. Past the bodies ceiling the doc agent gets
// the command instead. It runs in this worktree with shell access, so that costs it one call.
test(
  'boundedDiff drops the bodies past the ceiling and hands over the git command',
  { concurrency: true },
  () => {
    const repoRoot = makeGitRepo();
    const worktreeDir = freshWorktreeDir();
    createWorktree(repoRoot, {
      branch: 'glafka/2026-08-11-a-ticket-too-big-to-paste',
      worktreeDir,
      baseRef: 'main',
    });

    // Many files, so the per-file cap cannot save us: the total is what overflows.
    for (let i = 0; i < 12; i += 1) {
      fs.writeFileSync(path.join(worktreeDir, `f${i}.js`), 'x\n'.repeat(20));
    }
    execFileSync('git', ['add', '-A'], { cwd: worktreeDir });
    execFileSync('git', ['commit', '-q', '-m', 'a lot of files'], { cwd: worktreeDir });

    const out = boundedDiff(worktreeDir, 'main', 40, 1200, 20);

    // Every file still NAMED — that is what picks which docs to check.
    assert.match(out, /12 file\(s\) changed:/);
    for (let i = 0; i < 12; i += 1) assert.match(out, new RegExp(`f${i}\\.js`));

    // No diff bodies, and no fence pretending instructions are a diff.
    assert.ok(!out.includes('```diff'), 'bodies were pasted anyway');
    assert.ok(!out.includes('@@'), 'hunk headers leaked into an oversized diff');

    // The exact command, runnable from anywhere thanks to -C.
    assert.match(out, new RegExp(`git -C ${worktreeDir} diff --submodule=diff main\\.\\.\\.HEAD`));
  },
);

// The ceiling that ships, not one the test picks. A real 47-file change on this repo measured 1365
// lines of bodies, so the first ceiling tried — 1500 — let exactly the size that hurts paste
// anyway. This fixture lands in that same band on purpose: it must hand over, not paste.
test(
  'boundedDiff hands over at its DEFAULT ceiling, on a mid-size change',
  { concurrency: true },
  () => {
    const repoRoot = makeGitRepo();
    const worktreeDir = freshWorktreeDir();
    createWorktree(repoRoot, {
      branch: 'glafka/2026-08-11-a-mid-size-ticket',
      worktreeDir,
      baseRef: 'main',
    });

    // 30 files × 60 lines: each chunk caps at 40 lines plus its "… more" note, so the bodies land
    // around 1200 lines — over the shipped ceiling, under the 1500 it replaced.
    for (let i = 0; i < 30; i += 1) {
      fs.writeFileSync(path.join(worktreeDir, `m${i}.js`), 'x\n'.repeat(60));
    }
    execFileSync('git', ['add', '-A'], { cwd: worktreeDir });
    execFileSync('git', ['commit', '-q', '-m', 'a mid-size change'], { cwd: worktreeDir });

    const out = boundedDiff(worktreeDir, 'main');

    assert.match(out, /30 file\(s\) changed:/);
    assert.ok(!out.includes('```diff'), 'a mid-size change still pasted its bodies');
    assert.match(out, /git -C .* diff --submodule=diff main\.\.\.HEAD/);
  },
);

// Under the ceiling nothing changes for the agent: a diff it can read inline is simpler than a
// command it has to run, and this is the common case.
test('boundedDiff still fences the bodies inline when they fit', { concurrency: true }, () => {
  const repoRoot = makeGitRepo();
  const worktreeDir = freshWorktreeDir();
  createWorktree(repoRoot, {
    branch: 'glafka/2026-08-11-a-ticket-that-fits',
    worktreeDir,
    baseRef: 'main',
  });

  fs.writeFileSync(path.join(worktreeDir, 'small.js'), 'one\ntwo\n');
  execFileSync('git', ['add', '-A'], { cwd: worktreeDir });
  execFileSync('git', ['commit', '-q', '-m', 'a small change'], { cwd: worktreeDir });

  const out = boundedDiff(worktreeDir, 'main');

  assert.match(out, /1 file\(s\) changed:/);
  assert.ok(out.includes('```diff'), 'a diff that fits should still be fenced');
  assert.match(out, /\+one/);
  assert.ok(!out.includes('git -C '), 'no need to send the agent to git for a diff it can see');
});

test(
  'diffStat counts files and total lines changed, free facts for the review router',
  { concurrency: true },
  () => {
    const repoRoot = makeGitRepo();
    const worktreeDir = freshWorktreeDir();
    createWorktree(repoRoot, {
      branch: 'glafka/2026-08-01-a-diff-with-deletions',
      worktreeDir,
      baseRef: 'main',
    });

    fs.writeFileSync(path.join(worktreeDir, 'a.js'), 'one\ntwo\nthree\n');
    fs.writeFileSync(path.join(worktreeDir, 'b.js'), 'x\n');
    execFileSync('git', ['add', 'a.js', 'b.js'], { cwd: worktreeDir });
    execFileSync('git', ['commit', '-q', '-m', 'add files'], { cwd: worktreeDir });

    assert.deepEqual(diffStat(worktreeDir, 'main'), { files: 2, lines: 4 });
  },
);

// The file must exist on main before the branch starts.
// Otherwise the diff looks wrong.
test('diffStat counts pure deletions, not just additions', { concurrency: true }, () => {
  const repoRoot = makeGitRepo();
  fs.writeFileSync(path.join(repoRoot, 'a.js'), 'one\ntwo\nthree\n');
  execFileSync('git', ['add', 'a.js'], { cwd: repoRoot });
  execFileSync('git', ['commit', '-q', '-m', 'add a on main'], { cwd: repoRoot });

  const worktreeDir = freshWorktreeDir();
  createWorktree(repoRoot, {
    branch: 'glafka/2026-08-01-a-diff-with-deletions-two',
    worktreeDir,
    baseRef: 'main',
  });

  fs.writeFileSync(path.join(worktreeDir, 'a.js'), 'one\n');
  execFileSync('git', ['add', 'a.js'], { cwd: worktreeDir });
  execFileSync('git', ['commit', '-q', '-m', 'shrink a'], { cwd: worktreeDir });

  assert.deepEqual(diffStat(worktreeDir, 'main'), { files: 1, lines: 2 });
});

test('diffStat returns zeros for a diff with no changes', { concurrency: true }, () => {
  const repoRoot = makeGitRepo();
  const worktreeDir = freshWorktreeDir();
  createWorktree(repoRoot, {
    branch: 'glafka/2026-08-01-a-diff-with-no-changes',
    worktreeDir,
    baseRef: 'main',
  });

  assert.deepEqual(diffStat(worktreeDir, 'main'), { files: 0, lines: 0 });
});

test("headCommit returns the worktree's current HEAD sha", { concurrency: true }, () => {
  const repoRoot = makeGitRepo();
  const worktreeDir = freshWorktreeDir();
  createWorktree(repoRoot, {
    branch: 'glafka/2026-08-01-the-head-commit',
    worktreeDir,
    baseRef: 'main',
  });

  const sha = headCommit(worktreeDir);
  const expected = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: worktreeDir,
    encoding: 'utf8',
  }).trim();

  assert.equal(sha, expected);
  assert.match(sha, /^[0-9a-f]{40}$/);
});

test(
  "rebaseOnto replays the branch's commits on top of what actually landed on origin's base",
  { concurrency: true },
  () => {
    const repoRoot = makeGitRepo();
    addBareRemote(repoRoot);
    const worktreeDir = freshWorktreeDir();
    createWorktree(repoRoot, {
      branch: 'glafka/2026-08-01-the-head-commit-two',
      worktreeDir,
      baseRef: 'main',
    });

    // The ticket's own work, on its branch.
    fs.writeFileSync(path.join(worktreeDir, 'feature.txt'), "the ticket's work\n");
    execFileSync('git', ['add', 'feature.txt'], { cwd: worktreeDir });
    execFileSync('git', ['commit', '-q', '-m', 'ticket work'], { cwd: worktreeDir });

    // Someone else's work lands on main and gets pushed.
    fs.writeFileSync(path.join(repoRoot, 'other-work.txt'), "someone else's work\n");
    execFileSync('git', ['add', 'other-work.txt'], { cwd: repoRoot });
    execFileSync('git', ['commit', '-q', '-m', 'other work'], { cwd: repoRoot });
    execFileSync('git', ['push', 'origin', 'main'], { cwd: repoRoot });

    rebaseOnto(worktreeDir, 'main');

    // Both files exist, so the ticket's commit was replayed on the new base.
    assert.equal(fs.existsSync(path.join(worktreeDir, 'other-work.txt')), true);
    assert.equal(fs.existsSync(path.join(worktreeDir, 'feature.txt')), true);

    const log = execFileSync('git', ['log', '--oneline', 'origin/main..HEAD'], {
      cwd: worktreeDir,
      encoding: 'utf8',
    });
    assert.equal(log.trim().split('\n').length, 1); // only the ticket's own commit is ahead
  },
);

test(
  'commitsSince counts 0 right at the baseline, then grows with each real commit',
  { concurrency: true },
  () => {
    const repoRoot = makeGitRepo();
    const worktreeDir = freshWorktreeDir();
    createWorktree(repoRoot, {
      branch: 'glafka/2026-08-01-the-head-commit-three',
      worktreeDir,
      baseRef: 'main',
    });
    const baseline = headCommit(worktreeDir);

    assert.equal(commitsSince(worktreeDir, baseline), 0);

    fs.writeFileSync(path.join(worktreeDir, 'step1.txt'), 'step 1\n');
    execFileSync('git', ['add', 'step1.txt'], { cwd: worktreeDir });
    execFileSync('git', ['commit', '-q', '-m', 'step 1'], { cwd: worktreeDir });
    assert.equal(commitsSince(worktreeDir, baseline), 1);

    fs.writeFileSync(path.join(worktreeDir, 'step2.txt'), 'step 2\n');
    execFileSync('git', ['add', 'step2.txt'], { cwd: worktreeDir });
    execFileSync('git', ['commit', '-q', '-m', 'step 2'], { cwd: worktreeDir });
    assert.equal(commitsSince(worktreeDir, baseline), 2);
  },
);

test("latestCommitMessage returns the current HEAD's subject line", { concurrency: true }, () => {
  const repoRoot = makeGitRepo();
  const worktreeDir = freshWorktreeDir();
  createWorktree(repoRoot, {
    branch: 'glafka/2026-08-01-the-latest-commit-message',
    worktreeDir,
    baseRef: 'main',
  });

  fs.writeFileSync(path.join(worktreeDir, 'a.txt'), 'a\n');
  execFileSync('git', ['add', 'a.txt'], { cwd: worktreeDir });
  execFileSync('git', ['commit', '-q', '-m', 'add a validation step'], { cwd: worktreeDir });

  assert.equal(latestCommitMessage(worktreeDir), 'add a validation step');
});

test(
  'ticketCommitMessages lists subjects oldest first, with none before any commit lands',
  { concurrency: true },
  () => {
    const repoRoot = makeGitRepo();
    const worktreeDir = freshWorktreeDir();
    createWorktree(repoRoot, {
      branch: 'glafka/2026-08-01-the-latest-commit-message-two',
      worktreeDir,
      baseRef: 'main',
    });
    const baseline = headCommit(worktreeDir);

    assert.deepEqual(ticketCommitMessages(worktreeDir, baseline), []);

    for (const step of ['step 1', 'step 2', 'step 3']) {
      fs.writeFileSync(path.join(worktreeDir, `${step.replace(' ', '-')}.txt`), step);
      execFileSync('git', ['add', '.'], { cwd: worktreeDir });
      execFileSync('git', ['commit', '-q', '-m', step], { cwd: worktreeDir });
    }

    assert.deepEqual(ticketCommitMessages(worktreeDir, baseline), ['step 1', 'step 2', 'step 3']);
  },
);

test(
  'refExists distinguishes a real branch from one that was never created',
  { concurrency: true },
  () => {
    const repoRoot = makeGitRepo();

    assert.equal(refExists(repoRoot, 'main'), true);
    assert.equal(refExists(repoRoot, 'master'), false);
  },
);

test('detectBaseRef follows origin/HEAD rather than assuming main', { concurrency: true }, () => {
  const repoRoot = makeGitRepo({ branch: 'master' });
  addBareRemote(repoRoot, { branch: 'master' });

  assert.equal(detectBaseRef(repoRoot), 'master');
});

test(
  'detectBaseRef falls back to the branch that exists when there is no remote',
  { concurrency: true },
  () => {
    // This broke a real project before: a repo with only "master", no "main".
    // Guessing wrong here makes every ticket fail.
    assert.equal(detectBaseRef(makeGitRepo({ branch: 'master' })), 'master');
    assert.equal(detectBaseRef(makeGitRepo({ branch: 'main' })), 'main');
  },
);

test(
  'listGitlinks reports real submodules and ignores phantom .gitmodules entries',
  { concurrency: true },
  () => {
    const { repoRoot } = makeRepoWithSubmodule();

    // .gitmodules lists both, but only one was added.
    assert.match(fs.readFileSync(path.join(repoRoot, '.gitmodules'), 'utf8'), /packages\/phantom/);
    assert.deepEqual(listGitlinks(repoRoot), ['packages/real']);
  },
);

test(
  'a fresh worktree has an empty submodule dir until initSubmodules populates it',
  { concurrency: true },
  () => {
    const { repoRoot } = makeRepoWithSubmodule();
    const worktreeDir = freshWorktreeDir();
    createWorktree(repoRoot, {
      branch: 'glafka/2026-08-01-origin-head-over-main',
      worktreeDir,
      baseRef: 'main',
    });

    const seeded = path.join(worktreeDir, 'packages/real', 'README.md');
    assert.equal(fs.existsSync(seeded), false, 'git worktree add should not populate submodules');

    withFileProtocol(() => initSubmodules(worktreeDir, listGitlinks(repoRoot)));

    assert.equal(fs.existsSync(seeded), true, 'initSubmodules should make the checkout complete');
  },
);

test('initSubmodules is a no-op for a repo with no submodules', { concurrency: true }, () => {
  const repoRoot = makeGitRepo();
  const worktreeDir = freshWorktreeDir();
  createWorktree(repoRoot, {
    branch: 'glafka/2026-08-01-a-repo-with-no-submodules',
    worktreeDir,
    baseRef: 'main',
  });

  assert.deepEqual(listGitlinks(repoRoot), []);
  assert.doesNotThrow(() => initSubmodules(worktreeDir, []));
});

test(
  'checkoutBranchIn gives a detached submodule a branch to commit onto',
  { concurrency: true },
  () => {
    const { repoRoot } = makeRepoWithSubmodule();
    const worktreeDir = freshWorktreeDir();
    createWorktree(repoRoot, {
      branch: 'glafka/2026-08-01-a-submodule-branch',
      worktreeDir,
      baseRef: 'main',
    });
    withFileProtocol(() => initSubmodules(worktreeDir, listGitlinks(repoRoot)));

    const submodule = path.join(worktreeDir, 'packages/real');
    assert.equal(currentBranch(submodule), 'HEAD', 'submodules come out of update detached');

    checkoutBranchIn(submodule, 'glafka/2026-08-01-a-submodule-branch');

    assert.equal(currentBranch(submodule), 'glafka/2026-08-01-a-submodule-branch');
  },
);

function commitInto(dir: string, filename: string, content: string) {
  fs.writeFileSync(path.join(dir, filename), content);
  execFileSync('git', ['add', filename], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', `add ${filename}`], { cwd: dir });
}

// First make real commits inside the submodule.
// Then commit the pointer update in the main repo.
function commitSubmoduleBump(worktreeDir: string, submoduleRelativePath: string, message: string) {
  execFileSync('git', ['add', submoduleRelativePath], { cwd: worktreeDir });
  execFileSync('git', ['commit', '-q', '-m', message], { cwd: worktreeDir });
}

// A submodule is its own git repo.
// This checks we see its real changes, not just a pointer update.
test(
  "branchDiff shows a submodule's own content diff, not just its pointer bump",
  { concurrency: true },
  () => {
    const { repoRoot } = makeRepoWithSubmodule();
    const worktreeDir = freshWorktreeDir();
    createWorktree(repoRoot, {
      branch: 'glafka/2026-08-01-a-bundled-submodule',
      worktreeDir,
      baseRef: 'main',
    });
    withFileProtocol(() => initSubmodules(worktreeDir, listGitlinks(repoRoot)));
    const submodule = path.join(worktreeDir, 'packages/real');
    checkoutBranchIn(submodule, 'glafka/2026-08-01-a-bundled-submodule');

    commitInto(submodule, 'step1.txt', 'one\n');
    commitInto(submodule, 'step2.txt', 'two\n');
    commitInto(submodule, 'step3.txt', 'three\n');
    commitSubmoduleBump(worktreeDir, 'packages/real', 'bump packages/real: three steps');

    const diff = branchDiff(worktreeDir, 'main');

    assert.match(diff, /step1\.txt/);
    assert.match(diff, /step2\.txt/);
    assert.match(diff, /step3\.txt/);
    assert.doesNotMatch(
      diff,
      /Subproject commit/,
      'should be real content, not the bare pointer line',
    );
  },
);

// branchDiff only looks at the two saved commits, not the branch's live tip.
// A commit not linked to the ticket must not show up.
test(
  "branchDiff never leaks an unrelated commit on the submodule's own branch",
  { concurrency: true },
  () => {
    const { repoRoot, childRepo } = makeRepoWithSubmodule();
    const worktreeDir = freshWorktreeDir();
    createWorktree(repoRoot, {
      branch: 'glafka/2026-08-01-no-branch-leak',
      worktreeDir,
      baseRef: 'main',
    });
    withFileProtocol(() => initSubmodules(worktreeDir, listGitlinks(repoRoot)));
    const submodule = path.join(worktreeDir, 'packages/real');
    checkoutBranchIn(submodule, 'glafka/2026-08-01-no-branch-leak');
    commitInto(submodule, 'ticket-work.txt', "the ticket's own change\n");
    commitSubmoduleBump(worktreeDir, 'packages/real', 'bump packages/real: ticket work');

    // This commit happens after the ticket's pointer update.
    // It is not part of the ticket.
    commitInto(childRepo, 'unrelated.txt', "somebody else's unrelated work\n");

    const diff = branchDiff(worktreeDir, 'main');

    assert.match(diff, /ticket-work\.txt/, "the ticket's own commit is in the diff");
    assert.doesNotMatch(
      diff,
      /unrelated\.txt/,
      "somebody else's independent commit must not leak in",
    );
  },
);

// Work that is not committed does not show up in the diff.
// This is true in the main repo and in submodules.
test(
  'branchDiff shows nothing for uncommitted work, superproject or submodule',
  { concurrency: true },
  () => {
    const { repoRoot } = makeRepoWithSubmodule();
    const worktreeDir = freshWorktreeDir();
    createWorktree(repoRoot, {
      branch: 'glafka/2026-08-01-an-uncommitted-submodule',
      worktreeDir,
      baseRef: 'main',
    });
    withFileProtocol(() => initSubmodules(worktreeDir, listGitlinks(repoRoot)));

    fs.writeFileSync(path.join(worktreeDir, 'forgot-to-commit.txt'), 'oops\n');
    fs.writeFileSync(path.join(worktreeDir, 'packages/real', 'also-forgot.txt'), 'oops too\n');

    const diff = branchDiff(worktreeDir, 'main');

    assert.doesNotMatch(diff, /forgot-to-commit/);
    assert.doesNotMatch(diff, /also-forgot/);
  },
);

// Big diffs used to crash instead of returning a result.
// This checks a big diff now works fine.
test(
  "branchDiff returns a diff far past Node's 1MB default instead of throwing ENOBUFS",
  { concurrency: true },
  () => {
    const repoRoot = makeGitRepo();
    const worktree = path.join(os.tmpdir(), `glafka-bigdiff-${process.pid}`);
    createWorktree(repoRoot, { branch: 'big', worktreeDir: worktree, baseRef: 'main' });

    try {
      // Each line is different, so git cannot shrink them.
      const lines = Array.from({ length: 60_000 }, (_, i) => `line ${i} ${'x'.repeat(20)}`);
      fs.writeFileSync(path.join(worktree, 'big.txt'), `${lines.join('\n')}\n`);
      execFileSync('git', ['add', 'big.txt'], { cwd: worktree });
      execFileSync('git', ['commit', '-q', '-m', 'big'], { cwd: worktree });

      const diff = branchDiff(worktree, 'main');

      assert.ok(diff.length > 1024 * 1024, `diff was only ${diff.length} bytes`);
      assert.match(diff, /\+line 59999/);
    } finally {
      removeWorktree(repoRoot, worktree, { force: true });
    }
  },
);

// commitFile should commit only the one file it was given, not everything staged.
test('commitFile commits only the file it was given', () => {
  const repoRoot = makeGitRepo();
  fs.writeFileSync(path.join(repoRoot, 'mine.txt'), 'mine\n');
  fs.writeFileSync(path.join(repoRoot, 'someone-elses.txt'), 'not mine\n');
  // Another file is already staged before commitFile runs.
  execFileSync('git', ['add', 'someone-elses.txt'], { cwd: repoRoot });

  commitFile(repoRoot, 'mine.txt', 'add mine');

  const committed = execFileSync('git', ['show', '--name-only', '--format=', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
  assert.deepEqual(committed, ['mine.txt']);

  const stillStaged = execFileSync('git', ['diff', '--cached', '--name-only'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
  assert.equal(stillStaged, 'someone-elses.txt', 'the other file must stay where it was');
});

// The bug: `planCommit..HEAD` is a range from a FIXED commit, so it widens on its own every
// time the base branch is merged in. A branch with 13 commits of its own reported 17 — four of them
// main's, listed under this ticket as if the coder had written them.
test('ticket commits exclude work merged in FROM the base branch', () => {
  const repoRoot = makeGitRepo();
  const worktreeDir = freshWorktreeDir();
  createWorktree(repoRoot, {
    branch: 'glafka/2026-08-09-benchmark-harness',
    worktreeDir,
    baseRef: 'main',
  });
  const planCommit = headCommit(worktreeDir);

  const commitIn = (dir: string, file: string, message: string) => {
    fs.writeFileSync(path.join(dir, file), message);
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', message], { cwd: dir });
  };

  commitIn(worktreeDir, 'bench.ts', 'the ticket writes its own step');
  // Someone else moves main on, and the branch catches up to it.
  commitIn(repoRoot, 'tenancy.ts', 'Tenancy, permissions and production bootstrap');
  execFileSync('git', ['merge', '--no-edit', 'main'], { cwd: worktreeDir });

  assert.deepEqual(
    ticketCommitMessages(worktreeDir, planCommit, 'main'),
    ['the ticket writes its own step'],
    "main's own commit is not one of this ticket's steps, and neither is the merge",
  );
  assert.equal(ticketCommits(worktreeDir, planCommit, 'main'), 1);

  // Without the base branch the old, wider range is what you get back.
  assert.equal(ticketCommits(worktreeDir, planCommit), 2);
});

// The tidy-up before a push commits what the doc agents wrote — and only that.
test('commitPaths commits under the given paths and leaves the rest alone', () => {
  const repoRoot = makeGitRepo();
  fs.mkdirSync(path.join(repoRoot, 'docs/glafka/architecture'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'docs/glafka/architecture/ci.md'), 'a remote exists now\n');
  fs.writeFileSync(path.join(repoRoot, 'src.ts'), 'code the agent had no business touching\n');

  const commit = commitPaths(repoRoot, ['docs/glafka'], 'docs: sync');
  assert.deepEqual(commit?.committed, ['docs/glafka/architecture/ci.md']);

  const untracked = execFileSync('git', ['status', '--porcelain'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
  assert.equal(untracked, '?? src.ts', 'code outside the docs root must not ride along');

  // Nothing changed since, so a second call is a quiet no-op rather than an
  // empty commit.
  assert.equal(commitPaths(repoRoot, ['docs/glafka'], 'docs: sync'), null);
});

// A rebase mints a new commit SHA for every commit it replays, even when the resulting file content
// is identical — proven directly on a real ticket: 13 commits rewritten, `git diff` against the old
// tip showing zero lines of difference. A key built from the SHA called that "never checked" and
// refused a push on code that had already passed, moments after it had already passed.
test(
  'worktreeCheckKey stays the same across a rebase that changes the SHA but not the content',
  { concurrency: true },
  () => {
    const repoRoot = makeGitRepo();
    const worktreeDir = freshWorktreeDir();
    createWorktree(repoRoot, { branch: 'ticket', worktreeDir, baseRef: 'main' });
    fs.writeFileSync(path.join(worktreeDir, 'feature.txt'), 'the ticket\n');
    commitFile(worktreeDir, 'feature.txt', 'feat: the ticket');

    const shaBefore = headCommit(worktreeDir);
    const before = worktreeCheckKey(worktreeDir, { checksCmd: 'npm test' });

    // Rewrites the SAME commit onto the SAME base — same content, new SHA (the message changes; a
    // real rebase changes at least the committer date and parent, which changes the SHA the same
    // way). This stands in for what epistle's own `rebaseOnto` does when it replays a branch's
    // commits: `--no-edit --date=now` alone was not enough here, because this test fixture pins
    // author/committer dates for reproducibility, and an amend that changes nothing git can see
    // reuses the identical SHA.
    execFileSync('git', ['commit', '--amend', '-q', '-m', 'feat: the ticket (reworded)'], {
      cwd: worktreeDir,
    });

    const shaAfter = headCommit(worktreeDir);
    const after = worktreeCheckKey(worktreeDir, { checksCmd: 'npm test' });

    assert.notEqual(shaBefore, shaAfter, 'the amend must really have minted a new SHA');
    assert.equal(before, after, 'the tree did not change, so the checks cache must still hit');
  },
);

test('worktreeCheckKey DOES change when new content actually lands', { concurrency: true }, () => {
  const repoRoot = makeGitRepo();
  const worktreeDir = freshWorktreeDir();
  createWorktree(repoRoot, { branch: 'ticket', worktreeDir, baseRef: 'main' });
  fs.writeFileSync(path.join(worktreeDir, 'feature.txt'), 'the ticket\n');
  commitFile(worktreeDir, 'feature.txt', 'feat: the ticket');
  const before = worktreeCheckKey(worktreeDir, { checksCmd: 'npm test' });

  fs.writeFileSync(path.join(worktreeDir, 'feature.txt'), 'a real second change\n');
  commitFile(worktreeDir, 'feature.txt', 'feat: more');
  const after = worktreeCheckKey(worktreeDir, { checksCmd: 'npm test' });

  assert.notEqual(before, after, 'content really did change, so the key must too');
});

// The push glafka's own rebase produces should always fast-forward — HEAD only ever moves by
// rebasing onto the base branch, never by fetching this branch's own remote. A rejection means
// something else reached origin for THIS branch since epistle last looked: a manual push, a second
// machine, a person pushing by hand. The raw git error for this is a wall of text about
// "non-fast-forward"; the point of PushRejectedError is naming the actual cause and the fix.
test(
  'push throws PushRejectedError, not a raw git error, when origin has diverged',
  { concurrency: true },
  () => {
    const repoRoot = makeGitRepo();
    const remoteDir = addBareRemote(repoRoot);
    const worktreeDir = freshWorktreeDir();
    createWorktree(repoRoot, { branch: 'ticket', worktreeDir, baseRef: 'main' });
    fs.writeFileSync(path.join(worktreeDir, 'feature.txt'), 'first push\n');
    commitFile(worktreeDir, 'feature.txt', 'feat: first');
    push(worktreeDir, 'ticket');

    // Someone else pushes to the SAME branch, from an independent clone — not a second worktree of
    // this same repo, which git refuses to let check out a branch already checked out elsewhere.
    const other = makeTempDir('elsewhere');
    execFileSync('git', ['clone', '-q', remoteDir, other]);
    execFileSync('git', ['checkout', '-q', 'ticket'], { cwd: other });
    fs.writeFileSync(path.join(other, 'feature.txt'), 'pushed by hand\n');
    commitFile(other, 'feature.txt', 'a manual push');
    push(other, 'ticket');

    // The original worktree does not know about that yet, and tries to push its own (now stale) tip.
    fs.writeFileSync(path.join(worktreeDir, 'unrelated.txt'), 'more of the ticket\n');
    commitFile(worktreeDir, 'unrelated.txt', 'feat: more');

    assert.throws(
      () => push(worktreeDir, 'ticket'),
      (err: unknown) => {
        assert.ok(err instanceof PushRejectedError, `expected PushRejectedError, got ${err}`);
        assert.match((err as Error).message, /something else pushed to it/);
        // The full ref, so the printed command still works when a tag has the same name.
        assert.match(
          (err as Error).message,
          /force-with-lease origin refs\/heads\/ticket:refs\/heads\/ticket/,
        );
        return true;
      },
    );
  },
);

// `rev-parse --abbrev-ref` answered heads/<name> here, and ticket creation refused its own branch.
test('currentBranch names the branch even when a tag has the same name', () => {
  const repoRoot = makeGitRepo();
  execFileSync('git', ['checkout', '-q', '-b', 'glafka/t1'], { cwd: repoRoot });
  execFileSync('git', ['tag', 'glafka/t1'], { cwd: repoRoot });
  assert.equal(currentBranch(repoRoot), 'glafka/t1');

  execFileSync('git', ['checkout', '-q', '--detach'], { cwd: repoRoot });
  assert.equal(currentBranch(repoRoot), 'HEAD', 'detached, as before');
});

// The last fallback is the current branch. `--abbrev-ref` named it heads/develop next to a tag.
test('detectBaseRef names the current branch even when a tag has the same name', () => {
  const repoRoot = makeGitRepo({ branch: 'develop' });
  execFileSync('git', ['tag', 'develop'], { cwd: repoRoot });
  assert.equal(detectBaseRef(repoRoot), 'develop');
});

// An empty repo has a branch name but no commit. That is still "no base".
test('detectBaseRef is null for a repo with no commits', () => {
  const repoRoot = makeTempDir('empty-repo');
  execFileSync('git', ['init', '-q', '-b', 'develop'], { cwd: repoRoot });
  assert.equal(detectBaseRef(repoRoot), null);
});
