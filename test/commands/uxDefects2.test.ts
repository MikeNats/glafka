import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { makeGitRepo, addBareRemote } from '../helpers/gitFixture.js';
import { createTicket, attachSpec, attachPlan } from '../../src/commands/genesis/genesis.js';
import { readBaseline } from '../../src/checksBaseline.js';
import { guessableChecks } from '../../src/checks.js';
import { parseVerdictFromLog, parseStuckFromLog } from '../../src/commands/ergon/utils.js';
import { buildErgonPrompt, buildReviewPrompt } from '../../src/commands/ergon/prompts.js';
import { makeTempDir } from '../helpers/tempDir.js';
import {
  ergon,
  ergonReview,
  blockingReviewerReports,
  NothingToReviewError,
} from '../../src/commands/ergon/ergon.js';
import { runFiles } from '../../src/ticket/paths.js';
import { markExternalRunStarted, markExternalRunFinished } from '../../src/ticket/background.js';
import { readTicket, reviewFindings, setReviewerRoles } from '../../src/ticket/ticketStore.js';
import { noAgentCmd, EXAMPLE_AGENT_CMD } from '../../src/config.js';
import { fileURLToPath } from 'node:url';

import { epistle } from '../../src/commands/epistle/epistle.js';
import { PullRequestFailedError } from '../../src/util/git.js';
import { poreia, renderPoreia } from '../../src/commands/poreia/poreia.js';
import { lastStageIndex, STAGES } from '../../src/ticket/ticketStore.js';
import { assertKnownFlags } from '../../installKit/bin/cli/args.js';
import { runErgon } from '../../installKit/bin/commands/ergon.js';
import { loadConfig } from '../../src/config.js';
import { runLogos } from '../../installKit/bin/commands/logos.js';
import { readRunRecords } from '../../src/audit/record.js';
import { glafkaCli } from '../../src/util/cli.js';
import { buildOdysseFullPrompt } from '../../src/commands/odysse/prompts.js';
import { withoutAgentCmd } from '../helpers/noAgentEnv.js';

// These tests need no agent configured. Cleared here, so running this file directly is safe too.
withoutAgentCmd();

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// The same list bin/commands/ergon.ts dispatches on.
const ERGON_FLAGS_FIXTURE = ['--review', '--status', '--background', '--finished', '--keep'];

// Captures what a command printed, so a test can assert on the words a user
// actually reads rather than on an internal return value.
async function capture(fn: () => unknown): Promise<{ out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...args: unknown[]) => out.push(args.map(String).join(' '));
  console.error = (...args: unknown[]) => err.push(args.map(String).join(' '));
  try {
    await fn();
  } finally {
    console.log = realLog;
    console.error = realError;
  }
  return { out: out.join('\n'), err: err.join('\n') };
}

function tempStateDir(): string {
  return makeTempDir('state2');
}

function writeFile(content: string): string {
  const filePath = path.join(makeTempDir('doc2'), 'doc.md');
  fs.writeFileSync(filePath, content);
  return filePath;
}

// A repo whose package.json defines a `lint` that fails and a `test` that passes — the shape the
// zero-config fallback guesses at, with one script already red before any ticket exists.
function repoWithRedLint(): string {
  const repoRoot = makeGitRepo();
  fs.writeFileSync(
    path.join(repoRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: 'baseline-fixture',
        private: true,
        scripts: {
          lint: 'node -e "process.exit(1)"',
          test: 'node -e "process.exit(0)"',
        },
      },
      null,
      2,
    )}\n`,
  );
  execFileSync('git', ['add', 'package.json'], { cwd: repoRoot });
  execFileSync('git', ['commit', '-q', '-m', 'add scripts'], { cwd: repoRoot });
  return repoRoot;
}

async function provisionedTicket(repoRoot: string, stateDir: string) {
  const created = createTicket({ stateDir, repoRoot, content: 'add a thing' });
  attachSpec({ stateDir, repoRoot, id: created.id, specPath: writeFile('spec'), title: 'A thing' });
  return attachPlan({ stateDir, repoRoot, id: created.id, planPath: writeFile('1. do it') });
}

// A coder run that has already ended, without spawning anything. `--status` only runs the checks once
// the run is over, so a fixture that never ran a coder never reaches the lines under test.
function finishedCoderRun(stateDir: string, id: string, log = 'done\n'): void {
  markExternalRunStarted({ stateDir, id, role: 'coder' });
  fs.writeFileSync(runFiles(stateDir, id, 'coder').logPath, log);
  markExternalRunFinished({ stateDir, id, role: 'coder' });
}

// A ticket with a real commit on a repo with a real (bare) remote, so `epistle` reaches the push. The
// review gate is bypassed with `unreviewed`; it is covered by its own tests and is not what these are about.
async function pushableTicket(repoRoot: string, stateDir: string, content = 'push me') {
  const created = createTicket({ stateDir, repoRoot, content });
  attachSpec({
    stateDir,
    repoRoot,
    id: created.id,
    specPath: writeFile(content),
    title: 'Push me',
  });
  const ticket = await attachPlan({
    stateDir,
    repoRoot,
    id: created.id,
    planPath: writeFile('1. do it'),
  });
  fs.writeFileSync(path.join(ticket.worktree!, 'work.txt'), 'real work\n');
  execFileSync('git', ['add', 'work.txt'], { cwd: ticket.worktree! });
  execFileSync('git', ['commit', '-q', '-m', 'do the work'], { cwd: ticket.worktree! });
  return readTicket(stateDir, created.id);
}

// ---------------------------------------------------------------------------

// The baseline used to be recorded under the sha BEFORE glafka's own `.gitignore` commit, while ergon
// reads it back under `planCommit` — the sha AFTER it. The lookup never hit, so a check that was already red on the base commit was still charged to the coder, three paid runs deep.
test('the checks baseline is keyed on the same commit the ticket records as planCommit', async () => {
  const repoRoot = repoWithRedLint();
  const stateDir = tempStateDir();

  const ticket = await provisionedTicket(repoRoot, stateDir);

  assert.notEqual(ticket.planCommit, null, 'the ticket must record a starting commit');
  const baseline = readBaseline(stateDir, ticket.planCommit!);
  assert.notEqual(
    baseline,
    null,
    'ergon reads the baseline under planCommit — it must be written under that key',
  );
  assert.deepEqual(baseline!.failing, ['lint'], 'lint was already red before this ticket existed');
});

// The commit glafka makes for .gitignore is what made the two shas differ. Proving it happened keeps
// this test honest: without that commit the shas would match by accident and the test would pass on the broken code too.
test('the baseline key differs from the base branch head, because glafka commits .gitignore first', async () => {
  const repoRoot = repoWithRedLint();
  const stateDir = tempStateDir();
  const baseHead = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();

  const ticket = await provisionedTicket(repoRoot, stateDir);

  assert.notEqual(
    ticket.planCommit,
    baseHead,
    'glafka commits .gitignore into the worktree, so the ticket starts one commit past the base',
  );
  assert.equal(
    readBaseline(stateDir, baseHead),
    null,
    'nothing may be left behind under the old, unread key',
  );
});

// ---------------------------------------------------------------------------

// Recording the baseline runs the project's own scripts. On a real suite that is minutes of total
// silence right after plan approval, indistinguishable from a hang.
test('provisioning says out loud that it is running the guessed checks', async () => {
  const repoRoot = repoWithRedLint();
  const stateDir = tempStateDir();

  const said: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => said.push(args.map(String).join(' '));
  try {
    await provisionedTicket(repoRoot, stateDir);
  } finally {
    console.error = realError;
  }

  const line = said.find((s) => s.includes('checks baseline'));
  assert.notEqual(line, undefined, 'a baseline run must announce itself before it spends minutes');
  assert.match(line!, /lint/, 'it names the scripts it is about to run');
  assert.match(line!, /checksCmd/, 'it names the setting that skips it');
});

test('nothing is announced when there is no baseline to take', async () => {
  // No package.json scripts at all, so the zero-config fallback finds nothing.
  const repoRoot = makeGitRepo();
  const stateDir = tempStateDir();

  const said: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => said.push(args.map(String).join(' '));
  try {
    await provisionedTicket(repoRoot, stateDir);
  } finally {
    console.error = realError;
  }

  assert.equal(
    said.some((s) => s.includes('checks baseline')),
    false,
    'a no-op must stay silent',
  );
});

test('guessableChecks names only the convenience scripts the project actually defines', () => {
  const dir = makeTempDir('guessable');
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ scripts: { test: 'x', build: 'y' } }),
  );
  assert.deepEqual(guessableChecks(dir), ['test'], 'build is not one of the three glafka guesses');

  const empty = makeTempDir('guessable');
  assert.deepEqual(guessableChecks(empty), [], 'no manifest means nothing to guess');
});

// ---------------------------------------------------------------------------

// glafka's own reviewer prompt used to demonstrate the verdict inside a code fence, and the parser
// read only the very last non-empty line — so a model that mirrored the shape it was shown, bolded the line, or added one sentence of sign-off produced `source: NONE` and an unpushable ticket.
test('the verdict line is read through a fence, bold, a bullet, and a trailing sign-off', () => {
  const dir = tempStateDir();
  const logPath = path.join(dir, 'log');
  const read = (body: string) => {
    fs.writeFileSync(logPath, body);
    return parseVerdictFromLog(logPath);
  };

  assert.deepEqual(read('ok\n\nVERDICT: clean\n'), { verdict: 'clean', finding: null });
  assert.deepEqual(
    read('ok\n\n```\nVERDICT: clean\n```\n'),
    { verdict: 'clean', finding: null },
    'the prompt itself shows the line inside a fence',
  );
  assert.deepEqual(read('ok\n\n**VERDICT: clean**\n'), { verdict: 'clean', finding: null });
  assert.deepEqual(read('ok\n\n- VERDICT: clean\n'), { verdict: 'clean', finding: null });
  assert.deepEqual(
    read('VERDICT: blocking — no tests\n\nLet me know if you want anything else.\n'),
    { verdict: 'blocking', finding: 'no tests' },
    'a sentence after the verdict must not erase it',
  );
});

test('an earlier verdict inside the diff is not mistaken for the reviewer’s own', () => {
  const dir = tempStateDir();
  const logPath = path.join(dir, 'log');
  // A quoted VERDICT far above, then the real one at the end.
  fs.writeFileSync(
    logPath,
    `+VERDICT: clean\n${'filler\n'.repeat(40)}VERDICT: blocking — real one\n`,
  );
  assert.deepEqual(parseVerdictFromLog(logPath), { verdict: 'blocking', finding: 'real one' });
});

test('a log with no verdict anywhere still reads as no verdict', () => {
  const dir = tempStateDir();
  const logPath = path.join(dir, 'log');
  fs.writeFileSync(logPath, 'I reviewed it and it seemed fine to me.\n');
  assert.equal(parseVerdictFromLog(logPath), null);
});

// Widening the verdict window must not undo the rule that a VERDICT line sitting above substantive
// output is not the round's answer. The window is two lines of real content — one closing sentence, and no more.
test('a verdict with more than one line of real content after it is still not read', () => {
  const dir = tempStateDir();
  const logPath = path.join(dir, 'log');

  fs.writeFileSync(logPath, 'VERDICT: clean\n\none closing sentence.\n');
  assert.notEqual(parseVerdictFromLog(logPath), null, 'one line after it is fine');

  fs.writeFileSync(logPath, 'VERDICT: clean\n\n-- diff for context --\n+const X = /^VERDICT:/;\n');
  assert.equal(
    parseVerdictFromLog(logPath),
    null,
    'two lines of real content after it means it was not the last word',
  );

  fs.writeFileSync(logPath, `VERDICT: clean\n${'noise\n'.repeat(30)}`);
  assert.equal(parseVerdictFromLog(logPath), null);
});

test('the reviewer prompt no longer shows the verdict in a shape the parser rejects', () => {
  const prompt = buildReviewPrompt({
    ticket: { id: '2026-08-07-add-search-filters', specText: 'do the thing' },
    diff: 'diff --git a/x b/x\n',
  });
  const shown = prompt.slice(prompt.lastIndexOf('VERDICT: clean'));
  assert.equal(
    shown.includes('```'),
    false,
    'a fenced example is the exact shape that used to break the parser',
  );
  assert.match(prompt, /no code fence, no bold/);
});

// ---------------------------------------------------------------------------

// `glafka aporia` is itself a shell command, so a coder with no shell — the one case that most needs
// it — could not record that it was stuck. It exited 0 and read as "finished".
test('a coder that could not run aporia can say STUCK in its own output instead', () => {
  const dir = tempStateDir();
  const logPath = path.join(dir, 'log');

  fs.writeFileSync(logPath, 'I wrote the code.\n\nSTUCK: cannot run npm test, permission denied\n');
  assert.equal(parseStuckFromLog(logPath), 'cannot run npm test, permission denied');

  fs.writeFileSync(logPath, '**STUCK: the plan names a file that does not exist**\n');
  assert.equal(
    parseStuckFromLog(logPath),
    'the plan names a file that does not exist',
    'same unwrapping as the verdict line',
  );

  fs.writeFileSync(logPath, 'All three steps are done and verified.\n');
  assert.equal(parseStuckFromLog(logPath), null, 'a normal finish is not an impasse');
});

test('the coder prompt tells it about the shell-free escape hatch', () => {
  const prompt = buildErgonPrompt({
    ticket: { id: '2026-08-07-add-search-filters' },
    planContent: '1. do it',
  });
  assert.match(
    prompt,
    /glafka aporia 2026-08-07-add-search-filters/,
    'the command is still the first answer',
  );
  assert.match(prompt, /STUCK: <what the plan got wrong/, 'and there is a way out without a shell');
});

// ---------------------------------------------------------------------------

// glafka commits `.gitignore` into every new worktree, so a coder that committed absolutely nothing
// still left a one-line diff vs the base branch — and a real, paid reviewer was dispatched to read glafka's own bookkeeping.
test('a coder that committed nothing does not earn a reviewer', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = tempStateDir();
  const ticket = await provisionedTicket(repoRoot, stateDir);

  // The branch is exactly what provisioning left: glafka's .gitignore commit.
  const log = execFileSync('git', ['log', '--oneline', 'main..HEAD'], {
    cwd: ticket.worktree!,
    encoding: 'utf8',
  });
  assert.equal(log.trim().split('\n').length, 1, 'the only commit is glafka’s own');

  await assert.rejects(
    () => ergonReview({ stateDir, id: ticket.id, repoRoot, baseRef: 'main' }),
    (err: Error) => {
      assert.equal(err instanceof NothingToReviewError, true, 'no reviewer may be spawned');
      assert.match(err.message, /no commits of its own since the plan was approved/);
      return true;
    },
  );
});

test('the refusal says so when the coder wrote code and never committed it', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = tempStateDir();
  const ticket = await provisionedTicket(repoRoot, stateDir);
  fs.writeFileSync(path.join(ticket.worktree!, 'work.txt'), 'never committed\n');

  await assert.rejects(
    () => ergonReview({ stateDir, id: ticket.id, repoRoot, baseRef: 'main' }),
    /uncommitted changes.*never committed it|worktree HAS uncommitted changes/s,
  );
});

test('a real commit is still reviewable', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = tempStateDir();
  const ticket = await provisionedTicket(repoRoot, stateDir);
  fs.writeFileSync(path.join(ticket.worktree!, 'work.txt'), 'real work\n');
  execFileSync('git', ['add', 'work.txt'], { cwd: ticket.worktree! });
  execFileSync('git', ['commit', '-q', '-m', 'do the work'], { cwd: ticket.worktree! });

  const prepared = await ergonReview({ stateDir, id: ticket.id, repoRoot, baseRef: 'main' });
  assert.match(prepared.diff, /work\.txt/);
});

test('every place that suggests an agent command suggests one that can actually work', () => {
  assert.match(EXAMPLE_AGENT_CMD, /permission-mode|allowedTools|dangerously/);
  const message = noAgentCmd('vima', 'coder');
  assert.match(message, /permission-mode/, 'the refusal must not teach a bare `claude -p`');
  assert.match(message, /WITHOUT asking/, 'and it must say why that matters');

  const readme = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
  const configExample = readme.slice(readme.indexOf('"agents": {'), readme.indexOf('"checksCmd"'));
  assert.equal(
    /"(coder|reviewer)":\s*"claude -p"/.test(configExample),
    false,
    'the README config example must not hand out a coder that cannot write a file',
  );
});

// ---------------------------------------------------------------------------

// Both real reviewers in the round-2 audit reported through the VERDICT line, not `krisis` — the
// documented path for a reviewer that cannot reach the CLI. The verdict survived; every reason behind it was dropped, so the next coder was restarted with no idea what was wrong.
test('a blocking verdict reported through the log carries its reasons into the next coder prompt', () => {
  const stateDir = tempStateDir();
  const id = '2026-08-07-add-search-filters';
  const { dir, logPath } = runFiles(stateDir, id, 'reviewer');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    logPath,
    '## Review Summary\n\n' +
      '- `src/strings.js:12` — slugify does not trim trailing hyphens\n' +
      '- no test covers the empty-string case\n\n' +
      'VERDICT: blocking — trailing hyphens are not trimmed\n',
  );

  const reports = blockingReviewerReports({
    stateDir,
    ticket: { id, reviewerRoles: ['reviewer'] },
  });

  assert.equal(reports.length, 1);
  assert.equal(reports[0]!.finding, 'trailing hyphens are not trimmed');
  assert.match(reports[0]!.report, /src\/strings\.js:12/, 'the per-line detail survives');
  assert.match(reports[0]!.report, /empty-string case/);
});

test('a clean log-line verdict contributes nothing to the fix list', () => {
  const stateDir = tempStateDir();
  const id = '2026-08-07-add-search-filters';
  const { dir, logPath } = runFiles(stateDir, id, 'reviewer');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(logPath, 'VERDICT: clean\n');

  assert.deepEqual(
    blockingReviewerReports({ stateDir, ticket: { id, reviewerRoles: ['reviewer'] } }),
    [],
  );
});

test('a log-line report is NOT written onto the ticket as a krisis finding', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = tempStateDir();
  const ticket = await provisionedTicket(repoRoot, stateDir);
  const { dir, logPath } = runFiles(stateDir, ticket.id, 'reviewer');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(logPath, 'VERDICT: blocking — something is wrong\n');
  setReviewerRoles(stateDir, ticket.id, ['reviewer']);

  const { prompt } = await ergon({ stateDir, id: ticket.id, repoRoot });

  assert.match(prompt, /## Read this first/, 'the coder is told what the reviewer objected to');
  assert.match(prompt, /something is wrong/);
  assert.deepEqual(
    reviewFindings(readTicket(stateDir, ticket.id)),
    [],
    'the findings array stays the record of real krisis calls — resolveVerdict reads it',
  );
});

// ---------------------------------------------------------------------------

// The push and the PR are two calls to two programs. `gh` fails for its own reasons — not logged in,
// not installed, remote is not GitHub — and when it did, the branch was already on the remote while the ticket recorded neither the push nor a PR, so `poreia` said `○ pushed`.
test('a PR that could not be opened still records the push that did happen', async () => {
  const repoRoot = makeGitRepo();
  addBareRemote(repoRoot);
  const stateDir = tempStateDir();
  const ticket = await pushableTicket(repoRoot, stateDir);

  await assert.rejects(
    () =>
      epistle({
        stateDir,
        id: ticket.id,
        repoRoot,
        base: 'main',
        unreviewed: true,
        createPr: () => {
          throw new PullRequestFailedError(
            '`gh pr create` failed: gh auth login\n  log in: gh auth login',
          );
        },
      }),
    (err: Error) => {
      assert.equal(err instanceof PullRequestFailedError, true);
      assert.match(err.message, /the branch IS pushed/, 'say what did happen, first');
      assert.match(err.message, /gh auth login/, "and keep gh's own reason");
      assert.match(err.message, /glafka epistle/, 'and how to retry just the PR');
      return true;
    },
  );

  const after = readTicket(stateDir, ticket.id);
  assert.equal(after.prUrl, null, 'there is no PR, and none is invented');
  assert.notEqual(
    lastStageIndex(after, STAGES.EPISTLE),
    -1,
    'but the push is on the record, so nobody re-runs the whole rebase looking for it',
  );

  const view = poreia({ stateDir, id: ticket.id });
  assert.equal(view.branchPushed, true);
  assert.equal(view.pushed, false);
  assert.match(renderPoreia(view), /branch pushed — but no PR was opened/);
});

test('a successful push still records the PR url and reads as fully pushed', async () => {
  const repoRoot = makeGitRepo();
  addBareRemote(repoRoot);
  const stateDir = tempStateDir();
  const ticket = await pushableTicket(repoRoot, stateDir);

  await epistle({
    stateDir,
    id: ticket.id,
    repoRoot,
    base: 'main',
    unreviewed: true,
    createPr: () => 'https://github.test/example/repo/pull/7',
  });

  const view = poreia({ stateDir, id: ticket.id });
  assert.equal(view.pushed, true);
  assert.match(renderPoreia(view), /✔ pushed {2}https:\/\/github\.test/);
});

test('a markdown spec heading does not become a PR title with a leading hash', async () => {
  const repoRoot = makeGitRepo();
  addBareRemote(repoRoot);
  const stateDir = tempStateDir();
  const ticket = await pushableTicket(repoRoot, stateDir, '# Add a slugify helper\n\nbody\n');

  let seen: string | null = null;
  await epistle({
    stateDir,
    id: ticket.id,
    repoRoot,
    base: 'main',
    unreviewed: true,
    createPr: ({ title }) => {
      seen = title;
      return 'https://github.test/example/repo/pull/8';
    },
  });

  assert.equal(seen, 'Add a slugify helper');
});

// ---------------------------------------------------------------------------

// `runErgon` dispatches on args.includes() and falls through to a mode that prints the coder prompt
// AND marks a run as started. `--stats` for `--status` silently gave the ticket a coder that does not exist.
test('an unknown flag is refused, with the near-miss named, before anything changes', () => {
  assert.throws(
    () =>
      assertKnownFlags(
        ['2026-08-07-add-search-filters', '--stats'],
        ERGON_FLAGS_FIXTURE,
        'usage: …',
      ),
    (err: Error) => {
      assert.match(err.message, /unknown flag/);
      assert.match(err.message, /--stats {2}— did you mean --status\?/);
      assert.match(err.message, /nothing was changed/);
      return true;
    },
  );

  assert.throws(
    () =>
      assertKnownFlags(
        ['2026-08-07-add-search-filters', '--reveiw'],
        ERGON_FLAGS_FIXTURE,
        'usage: …',
      ),
    /did you mean --review\?/,
  );

  // A flag with no near neighbour is still refused, just without a guess.
  assert.throws(
    () =>
      assertKnownFlags(['2026-08-07-add-search-filters', '--zzz'], ERGON_FLAGS_FIXTURE, 'usage: …'),
    /--zzz\n/,
  );
});

test('the real flags still pass, in any order and combination', () => {
  for (const args of [
    ['2026-08-07-add-search-filters'],
    ['2026-08-07-add-search-filters', '--status'],
    ['--background', '2026-08-07-add-search-filters'],
    ['2026-08-07-add-search-filters', '--review', '--status'],
    ['2026-08-07-add-search-filters', '--review', '--keep', 'all'],
    ['2026-08-07-add-search-filters', '--finished'],
  ]) {
    assert.doesNotThrow(
      () => assertKnownFlags(args, ERGON_FLAGS_FIXTURE, 'usage: …'),
      args.join(' '),
    );
  }
});

test('glafka ergon refuses a typo instead of dispatching a phantom coder', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = tempStateDir();
  const ticket = await provisionedTicket(repoRoot, stateDir);
  const before = readTicket(stateDir, ticket.id).stageLog.length;

  await assert.rejects(
    () =>
      runErgon({
        args: [ticket.id, '--stats'],
        repoRoot,
        stateDir,
        config: loadConfig(repoRoot),
        personaContent: null,
        profile: null,
      }),
    /unknown flag/,
  );

  assert.equal(
    readTicket(stateDir, ticket.id).stageLog.length,
    before,
    'no ergon stage may be appended by a typo',
  );
  assert.equal(
    fs.existsSync(runFiles(stateDir, ticket.id, 'coder').dir),
    false,
    'and no run directory may be created',
  );
});

// ---------------------------------------------------------------------------

// `runChecks` runs in the worktree — uncommitted edits included — while the review reads `git diff
// base...HEAD`. A coder that wrote correct code and committed none of it got `checks: PASSED` on work no reviewer will see.
test('a green check on a dirty worktree says which tree it read', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = tempStateDir();
  const ticket = await provisionedTicket(repoRoot, stateDir);
  fs.writeFileSync(path.join(ticket.worktree!, 'uncommitted.txt'), 'never committed\n');
  finishedCoderRun(stateDir, ticket.id);

  const printed = await capture(() =>
    runErgon({
      args: [ticket.id, '--status'],
      repoRoot,
      stateDir,
      config: { ...loadConfig(repoRoot), checksCmd: 'true' },
      personaContent: null,
      profile: null,
    }),
  );

  assert.match(printed.out, /0 commit\(s\) since plan approval/);
  assert.match(printed.out, /checks: PASSED \(working tree, including uncommitted changes/);
  assert.match(
    printed.out,
    /nothing is committed on this branch, so the check above proves nothing/,
  );
});

test('a green check on a branch with real commits is reported plainly', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = tempStateDir();
  const ticket = await provisionedTicket(repoRoot, stateDir);
  fs.writeFileSync(path.join(ticket.worktree!, 'work.txt'), 'real work\n');
  execFileSync('git', ['add', 'work.txt'], { cwd: ticket.worktree! });
  execFileSync('git', ['commit', '-q', '-m', 'do the work'], { cwd: ticket.worktree! });
  finishedCoderRun(stateDir, ticket.id);

  const printed = await capture(() =>
    runErgon({
      args: [ticket.id, '--status'],
      repoRoot,
      stateDir,
      config: { ...loadConfig(repoRoot), checksCmd: 'true' },
      personaContent: null,
      profile: null,
    }),
  );

  assert.match(printed.out, /checks: PASSED$/m, 'no caveat when there is nothing to caveat');
  assert.equal(printed.out.includes('proves nothing'), false);
});

// ---------------------------------------------------------------------------

// `logos`, `odysse` and `epistle`'s two follow-up prompts all resolve the `reporter` role, which the
// README never named. With the README's own example config, `logos` produced output byte-identical to the free `poreia` and said nothing about why.
test('logos says so when no reporter agent is configured', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = tempStateDir();
  const ticket = await provisionedTicket(repoRoot, stateDir);

  const printed = await capture(() =>
    runLogos({
      args: [ticket.id],
      stateDir,
      repoRoot,
      // Exactly the shape the README used to hand out: coder and reviewer set,
      // no reporter, no default.
      config: { ...loadConfig(repoRoot), agents: { coder: 'x', reviewer: 'y' } },
      personaContent: null,
    }),
  );

  assert.match(printed.err, /no "reporter" agent is configured/);
  assert.match(printed.err, /agents.*reporter/s, 'it names the key to set');
  assert.match(printed.err, /glafka poreia/, 'and the free command that does the same thing');
  assert.notEqual(printed.out.trim(), '', 'the report is still printed');
});

test('logos --raw stays silent, because skipping the agent is what was asked for', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = tempStateDir();
  const ticket = await provisionedTicket(repoRoot, stateDir);

  const printed = await capture(() =>
    runLogos({
      args: [ticket.id, '--raw'],
      stateDir,
      repoRoot,
      config: loadConfig(repoRoot),
      personaContent: null,
    }),
  );

  assert.equal(printed.err.includes('reporter'), false);
});

// A logos report calls an agent like any other, and it is billed like one — filed the same way a
// repo-level scan is, under the no-ticket record, since this call is about glafka's own tooling spend, not the ticket's coding work.
test('logos records the reporter call as an audit run', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = tempStateDir();
  const ticket = await provisionedTicket(repoRoot, stateDir);
  const usage = JSON.stringify({ usage: { input_tokens: 20, output_tokens: 5 } });

  await capture(() =>
    runLogos({
      args: [ticket.id],
      stateDir,
      repoRoot,
      config: {
        ...loadConfig(repoRoot),
        agents: { reporter: `printf '%s' ${JSON.stringify(usage)}` },
      },
      personaContent: null,
    }),
  );

  const [rec] = readRunRecords(stateDir, null);
  assert.equal(rec!.stage, 'logos');
  assert.equal(rec!.role, 'reporter');
  assert.deepEqual(rec!.tokens, { in: 20, out: 5 });
});

test('the README documents the reporter role', () => {
  const readme = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
  assert.match(readme, /`reporter`/, 'the fourth role has to be findable');
  assert.match(readme, /logos.*odysse.*epistle|reporter.*is the one people miss/s);
});

// ---------------------------------------------------------------------------

// `ergon --review` catches errors per ticket so one bad ticket cannot stop a queue — but it never set
// an exit code, so a run where NOTHING could be reviewed still exited 0 and any script or timer read a refusal as success.
test('a review round where nothing could be reviewed exits non-zero', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = tempStateDir();
  const ticket = await provisionedTicket(repoRoot, stateDir);
  const before = process.exitCode;
  process.exitCode = 0;
  try {
    const printed = await capture(() =>
      runErgon({
        args: [ticket.id, '--review'],
        repoRoot,
        stateDir,
        config: loadConfig(repoRoot),
        personaContent: null,
        profile: null,
      }),
    );
    assert.match(printed.err, /review preparation failed/);
    assert.equal(process.exitCode, 1, 'a refusal must not read as success to a script');
  } finally {
    process.exitCode = before;
  }
});

test('a review round that really started a review exits zero', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = tempStateDir();
  const ticket = await provisionedTicket(repoRoot, stateDir);
  fs.writeFileSync(path.join(ticket.worktree!, 'work.txt'), 'real work\n');
  execFileSync('git', ['add', 'work.txt'], { cwd: ticket.worktree! });
  execFileSync('git', ['commit', '-q', '-m', 'do the work'], { cwd: ticket.worktree! });

  const before = process.exitCode;
  process.exitCode = 0;
  try {
    await capture(() =>
      runErgon({
        args: [ticket.id, '--review'],
        repoRoot,
        stateDir,
        // No reviewer agent, so it prints the brief — which is still a review
        // round that got somewhere.
        config: loadConfig(repoRoot),
        personaContent: null,
        profile: null,
      }),
    );
    assert.equal(process.exitCode, 0);
  } finally {
    process.exitCode = before;
  }
});

// ---------------------------------------------------------------------------

// Every agent prompt told the agent to run bare `glafka krisis` / `aporia` / `psyche` / `guardrails
// --claim`. Those are its only ways to file a finding, report an impasse, record a convention, or claim the guardrails hook — and none of them resolves unless a global `glafka` happens to be on PATH. When it is not, glafka reports the result as "it never called krisis": a statement about the agent's choice, describing a missing binary.
test('glafkaCli falls back to the vendored copy only when no global one resolves', () => {
  const repoRoot = makeGitRepo();
  const noPath = { PATH: '' };

  assert.equal(
    glafkaCli(repoRoot, { env: noPath }),
    'glafka',
    'nothing global and nothing vendored: the short form is still the most diagnosable',
  );

  const vendored = path.join(repoRoot, '.glafka', 'bin');
  fs.mkdirSync(vendored, { recursive: true });
  fs.writeFileSync(path.join(vendored, 'glafka.js'), '');

  const cli = glafkaCli(repoRoot, { env: noPath });
  assert.equal(cli, `node ${path.join(vendored, 'glafka.js')}`);
  assert.equal(
    path.isAbsolute(cli.split(' ')[1]!),
    true,
    'the agent runs from the worktree, not from the repo root',
  );

  // A real, executable glafka on PATH wins — an agent's own permission allowlist is written by hand as
  // `Bash(glafka:*)` and is prefix-matched, so the absolute form would silently fail a rule the short form satisfies.
  const binDir = makeTempDir('bin');
  const shim = path.join(binDir, 'glafka');
  fs.writeFileSync(shim, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(shim, 0o755);
  assert.equal(glafkaCli(repoRoot, { env: { PATH: binDir } }), 'glafka');
});

test('a non-executable file named glafka on PATH does not count as resolving', () => {
  const repoRoot = makeGitRepo();
  const binDir = makeTempDir('bin');
  fs.mkdirSync(path.join(repoRoot, '.glafka', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, '.glafka', 'bin', 'glafka.js'), '');
  // Present, but not runnable — the shape a stale `npm link` leaves behind.
  fs.writeFileSync(path.join(binDir, 'glafka'), 'not executable');
  fs.chmodSync(path.join(binDir, 'glafka'), 0o644);

  assert.match(glafkaCli(repoRoot, { env: { PATH: binDir } }), /^node .*glafka\.js$/);
});

test('the coder prompt uses the resolved CLI, not the bare word', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = tempStateDir();
  // A vendored copy, as `glafka install` leaves behind.
  fs.mkdirSync(path.join(repoRoot, '.glafka', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, '.glafka', 'bin', 'glafka.js'), '');
  // The claim line only exists once a project asks for enforcement,
  // and it is one of the commands under test here.
  fs.mkdirSync(path.join(repoRoot, 'docs', 'glafka'), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, 'docs', 'glafka', 'guardrails.json'),
    `${JSON.stringify({ level: 2 }, null, 2)}\n`,
  );
  const ticket = await provisionedTicket(repoRoot, stateDir);

  const { prompt } = await ergon({ stateDir, id: ticket.id, repoRoot });

  // Whatever `glafkaCli` resolved to is what the agent is told to run. That is
  // the wiring under test; which form it picks is covered above.
  const cli = glafkaCli(repoRoot);
  assert.equal(prompt.includes(`${cli} aporia ${ticket.id}`), true, 'the impasse command');
  assert.equal(
    prompt.includes(`${cli} guardrails --claim ${ticket.id}`),
    true,
    'the claim command',
  );

  // And nothing is left addressing a binary that may not exist.
  if (cli !== 'glafka') {
    assert.equal(
      /(^|\s)glafka (aporia|ergon|psyche|krisis|guardrails)/m.test(prompt),
      false,
      'no bare `glafka <verb>` may survive in a prompt an agent has to execute',
    );
  }
});

test('the reviewer prompt uses the resolved CLI for krisis', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = tempStateDir();
  fs.mkdirSync(path.join(repoRoot, '.glafka', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, '.glafka', 'bin', 'glafka.js'), '');
  const ticket = await provisionedTicket(repoRoot, stateDir);
  fs.writeFileSync(path.join(ticket.worktree!, 'work.txt'), 'real work\n');
  execFileSync('git', ['add', 'work.txt'], { cwd: ticket.worktree! });
  execFileSync('git', ['commit', '-q', '-m', 'do the work'], { cwd: ticket.worktree! });

  const { prompt } = await ergonReview({ stateDir, id: ticket.id, repoRoot, baseRef: 'main' });

  assert.equal(prompt.includes(`${glafkaCli(repoRoot)} krisis ${ticket.id}`), true);
});

// ---------------------------------------------------------------------------

// `logos` and `odysse` share the `reporter` role and are not the same kind of job. `logos` re-words
// text; the full scan captures conventions by calling `odysse --propose`. Documenting a bare `claude -p` as safe for the role made it degrade to a report that changed nothing.
test('the README does not present a bare `claude -p` as enough for any role', () => {
  const readme = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
  const example = readme.slice(readme.indexOf('"agents": {'), readme.indexOf('"baseRef"'));

  assert.equal(
    /"(coder|reviewer|reporter)":\s*"claude -p"\s*[,}]/.test(example),
    false,
    'every role in the example must be able to work unattended',
  );
  assert.match(
    readme,
    /A bare `claude -p` asks for\s+permission/,
    'and the trap must be called out',
  );
});

test('the odysse scan prompt uses the resolved CLI for --propose', () => {
  const prompt = buildOdysseFullPrompt({
    tree: 'src/\n',
    repoRoot: '/tmp/x',
    categories: [{ name: 'code', hint: 'naming, imports, error handling' }],
    cli: 'node /abs/.glafka/bin/glafka.js',
  });
  assert.match(prompt, /node \/abs\/\.glafka\/bin\/glafka\.js odysse --propose/);
  assert.equal(
    /(^|\s)glafka odysse --propose/m.test(prompt),
    false,
    'a convention the agent cannot record is a convention lost',
  );
});
