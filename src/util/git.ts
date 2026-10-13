import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Node's default maxBuffer is 1 MB. Git output can be bigger, so raise it.
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;

interface GitOptions {
  cwd?: string;
  stdio?: 'pipe' | 'ignore' | 'inherit';
}

// A list of arguments, never one shell string,
// so odd path and branch names stay safe.
function git(args: string[], options: GitOptions = {}): string {
  return execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    ...options,
  });
}

// Every file git does not ignore, old and new.
// -z keeps odd characters in names safe.
export function listProjectFiles(dir: string): string[] {
  const out = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: dir });
  // A Set drops repeats, since a path can appear twice.
  return [...new Set(out.split('\0').filter(Boolean))];
}

// Ignored entries, whole directories collapsed to "dist/". Rules name
// git-ignored paths (.env, dist/) and those must not read as deleted.
export function listIgnoredEntries(dir: string): string[] {
  const out = git(
    ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'],
    {
      cwd: dir,
    },
  );
  return [...new Set(out.split('\0').filter(Boolean))];
}

export function createWorktree(
  repoRoot: string,
  { branch, worktreeDir, baseRef }: { branch: string; worktreeDir: string; baseRef: string },
): void {
  git(['worktree', 'add', '-b', branch, worktreeDir, baseRef], { cwd: repoRoot });
}

// Commits exactly these files and leaves other staged work alone. Null when
// there was nothing to commit, which is never an empty commit.
export function commitPaths(
  repoRoot: string,
  paths: string[],
  message: string,
): { sha: string; committed: string[] } | null {
  // A path git never heard of makes `add` fail. `resolve` not `join`: callers
  // pass absolute paths too, and joining those builds a path that exists nowhere.
  const present = paths.filter((p) => fs.existsSync(path.resolve(repoRoot, p)));
  if (present.length === 0) return null;
  git(['add', '--', ...present], { cwd: repoRoot });
  const staged = git(['diff', '--cached', '--name-only', '--', ...present], { cwd: repoRoot })
    .split('\n')
    .filter(Boolean);
  if (staged.length === 0) return null;
  git(['commit', '-m', message, '--', ...present], { cwd: repoRoot });
  return { sha: git(['rev-parse', 'HEAD'], { cwd: repoRoot }).trim(), committed: staged };
}

export function refExists(repoRoot: string, ref: string): boolean {
  try {
    git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: repoRoot, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// The repo's real default branch. "main" is not a safe guess, since many
// repos use master. We ask git first, then fall back to guesses.
export function detectBaseRef(repoRoot: string): string | null {
  try {
    const out = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
      cwd: repoRoot,
      stdio: 'pipe',
    }).trim();
    // Turn "origin/master" into "master".
    if (out.startsWith('origin/')) return out.slice('origin/'.length);
    if (out) return out;
  } catch {
    // Git has no answer here, so try the guesses below.
  }
  for (const candidate of ['main', 'master', 'trunk']) {
    if (refExists(repoRoot, candidate)) return candidate;
  }
  try {
    // refExists: an empty repo has a branch name but no commit, and that is still null.
    const current = currentBranch(repoRoot);
    if (current !== 'HEAD' && refExists(repoRoot, current)) return current;
  } catch {
    // An empty repo with no commits. The caller decides what null means.
  }
  return null;
}

// Submodule paths taken straight from git itself.
// We do not read .gitmodules, because that file can be out of date.
export function listGitlinks(repoRoot: string): string[] {
  const out = git(['ls-files', '-s', '-z'], { cwd: repoRoot });
  const paths: string[] = [];
  for (const entry of out.split('\0')) {
    if (!entry.startsWith('160000 ')) continue;
    // The line looks like: "160000 <id> <stage>\t<path>".
    const tab = entry.indexOf('\t');
    if (tab !== -1) paths.push(entry.slice(tab + 1));
  }
  return paths;
}

// `git worktree add` leaves submodules empty,
// because their .git link does not work from the new place. This fills them.
export function initSubmodules(worktreeDir: string, paths: string[] | null | undefined): void {
  if (!paths || paths.length === 0) return;
  git(['submodule', 'update', '--init', '--recursive', '--', ...paths], { cwd: worktreeDir });
}

// Submodules arrive with no branch. A ticket that commits inside one
// needs a real branch first.
export function checkoutBranchIn(dir: string, branch: string): void {
  git(['checkout', '-B', branch], { cwd: dir });
}

export function removeWorktree(
  repoRoot: string,
  worktreeDir: string,
  { force = false }: { force?: boolean } = {},
): void {
  const args = ['worktree', 'remove', worktreeDir];
  if (force) args.push('--force');
  git(args, { cwd: repoRoot });
}

export function deleteBranch(
  repoRoot: string,
  branch: string,
  { force = false }: { force?: boolean } = {},
): void {
  git(['branch', force ? '-D' : '-d', branch], { cwd: repoRoot });
}

// Which branch each live worktree is standing on, asked of git. This is the only honest answer to
// "is anything using this branch". A ticket file's `branch` field is what we MEANT to check out; a
// hand-renamed branch, or a ticket file written before a rename, makes the two disagree — and a
// sweep built on the ticket file then proposes deleting a branch a live checkout is on. Keyed by branch, valued by the worktree path, so a caller can say WHICH checkout
// is holding it rather than just refusing.
export function branchesInUseByWorktrees(repoRoot: string): Map<string, string> {
  const inUse = new Map<string, string>();
  // --porcelain emits blank-line-separated records: `worktree <path>`, then
  // `HEAD <sha>`, then either `branch refs/heads/<name>` or `detached`.
  const out = git(['worktree', 'list', '--porcelain'], { cwd: repoRoot });
  let worktree: string | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) worktree = line.slice('worktree '.length).trim();
    // A detached HEAD emits no `branch` line at all, so it holds no branch
    // and correctly contributes nothing here.
    else if (line.startsWith('branch ') && worktree) {
      const ref = line.slice('branch '.length).trim();
      inUse.set(ref.replace(/^refs\/heads\//, ''), worktree);
    }
  }
  return inUse;
}

export function hasUncommittedChanges(worktreeDir: string): boolean {
  const out = git(['status', '--porcelain'], { cwd: worktreeDir });
  return out.trim().length > 0;
}

// The same question as above, but it names the files. Callers that refuse to destroy work have to
// say WHICH work, or the refusal is not actionable. A missing or unreadable worktree reports
// nothing: it is not our job to diagnose that here, and the teardown below reports it properly.
export function uncommittedPaths(worktreeDir: string): string[] {
  try {
    const out = git(['status', '--porcelain'], { cwd: worktreeDir });
    return out.split('\n').filter((line) => line.trim().length > 0);
  } catch {
    return [];
  }
}

// Commits exactly one file. `git add -A` would pull in other changes too.
export function commitFile(worktreeDir: string, relativePath: string, message: string): void {
  git(['add', relativePath], { cwd: worktreeDir });
  // Naming the file on the commit too is what keeps this to one file.
  // Without it, anything already staged would ride along.
  git(['commit', '-q', '-m', message, '--', relativePath], { cwd: worktreeDir });
}

// The diff a review reads. It only shows COMMITTED work, which is why the
// coder is told to commit after each step. Two reviewers can read it at once.
export function branchDiff(worktreeDir: string, baseRef: string): string {
  return git(['diff', '--submodule=diff', `${baseRef}...HEAD`], { cwd: worktreeDir });
}

// How much of ONE file's diff a doc agent is given. Not a budget for the whole diff: `git diff`
// emits files in path order, so a single overall cap spends itself on whatever sorts first and the
// rest of the change never appears — the doc for a directory nobody showed you reads as "unchanged".
const DIFF_LINES_PER_FILE = 40;

// Past this, files are shown in SHORT form rather than dropped. Nothing ever disappears: the worst
// a file gets is its header and the first few lines, which is still enough to know it changed and
// roughly how.
const DIFF_TOTAL_CEILING_LINES = 1200;
const DIFF_LINES_WHEN_OVER_CEILING = 6;

// Past this, the bodies are dropped and the agent is pointed at git instead. Bounding per file
// bounds each file, not the total: 6 short lines across 400 files is still thousands, so a big
// enough ticket puts the prompt past what an agent will accept — and it then fails identically on
// every retry, because the prompt is the same size every time. The summary always survives: it
// names every changed file, which is what picks the docs to look at, and the agent reads only
// those paths' diffs. Nothing is truncated here, so nothing can be mistaken for unchanged.
// Measured, not guessed: a real 47-file change on this repo produced 1365 lines of bodies, so a
// 1500 ceiling let exactly the size that hurts slip through and paste anyway.
const DIFF_BODIES_CEILING_LINES = 1000;

// Splits a diff into one chunk per file. `diff --git` starts each one, and it is the only line that
// does — hunk headers start with `@@`, and content lines are always prefixed.
function splitDiffByFile(body: string): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  for (const line of body.split('\n')) {
    if (line.startsWith('diff --git ') && current.length > 0) {
      chunks.push(current.join('\n'));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) chunks.push(current.join('\n'));
  return chunks.filter((c) => c.trim() !== '');
}

// Every changed file with its added/removed counts. `--numstat`, not `--stat`: the pretty one
// abbreviates long paths to `.../foo.ts`, so the one thing this summary exists to guarantee — that
// every file is NAMED in full — was the thing it quietly broke.
function changeSummary(worktreeDir: string, baseRef: string): string {
  const out = git(['diff', '--numstat', `${baseRef}...HEAD`], { cwd: worktreeDir });
  const rows = out
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [added, removed, ...rest] = line.split('\t');
      const file = rest.join('\t');
      // "-" in both columns means binary.
      const counts = added === '-' ? 'binary' : `+${added} -${removed}`;
      return `  ${counts.padEnd(12)} ${file}`;
    });
  return `${rows.length} file(s) changed:\n${rows.join('\n')}`;
}

// The diff, bounded per file. The summary always comes first and always names EVERY changed file in
// full, so the shape of the change is complete even when a body is shortened.
//
// The doc prompts used to carry the whole diff: a dozen-commit ticket is tens of thousands of lines,
// paid for on every push, to answer "which sentences in this doc are now wrong?" — a question the
// shape of the change answers. Shortening is always SAID, per file, because an agent that believes
// it saw a whole file will describe the part it did not see as absent.
export function boundedDiff(
  worktreeDir: string,
  baseRef: string,
  perFile: number = DIFF_LINES_PER_FILE,
  ceiling: number = DIFF_TOTAL_CEILING_LINES,
  bodiesCeiling: number = DIFF_BODIES_CEILING_LINES,
): string {
  const summary = changeSummary(worktreeDir, baseRef);
  const body = branchDiff(worktreeDir, baseRef);
  if (body.trim() === '') return summary;

  const out: string[] = [];
  let used = 0;
  for (const chunk of splitDiffByFile(body)) {
    const lines = chunk.split('\n');
    // Over the ceiling a file is SHORTENED, never skipped. A skipped file is indistinguishable from
    // an unchanged one to whoever reads this, and that is the whole failure being avoided.
    const allowed = used >= ceiling ? DIFF_LINES_WHEN_OVER_CEILING : perFile;
    if (lines.length <= allowed) {
      out.push(chunk);
      used += lines.length;
      continue;
    }
    out.push(
      `${lines.slice(0, allowed).join('\n')}\n` +
        `… ${lines.length - allowed} more line(s) in this file — open it if you need them`,
    );
    used += allowed;
  }

  const bodies = out.join('\n');
  if (bodies.split('\n').length > bodiesCeiling) {
    return `${summary}\n\n${readTheDiffYourself(worktreeDir, baseRef)}`;
  }
  // Fenced here rather than by each prompt, because past the ceiling there is no diff to fence and
  // a caller that wrapped this in ```diff anyway would be labelling instructions as a diff.
  return `${summary}\n\n\`\`\`diff\n${bodies}\n\`\`\``;
}

// What replaces the diff bodies when there are too many of them. A command, not advice: these
// prompts are delivered to an agent whose cwd is the worktree, with shell access, so reading the
// real diff costs it one call — and `-C` makes that true wherever it is actually run from.
//
// Per PATH on purpose. A doc agent is answering "which sentences about THIS directory are now
// wrong?", so the whole diff was never the unit of work; the paths it is about to edit docs for are.
function readTheDiffYourself(worktreeDir: string, baseRef: string): string {
  return `Every changed file is named above, with its line counts. The diff bodies are not
pasted here: on a ticket this size they push the prompt past what you can accept,
which is why pasting them fails the same way on every retry.

Read the change yourself, one path at a time:

    git -C ${worktreeDir} diff --submodule=diff ${baseRef}...HEAD -- <path>

Read only the paths whose docs you are checking — you do not need the whole diff.
Nothing above was truncated or dropped, so a file missing from the list really is
a file this ticket did not touch.`;
}

// Every path that differs between `from` (a commit or a tree) and HEAD. `--no-renames`, so a moved
// file still names the path it left. `-z`, so a non-ASCII name is not quoted.
export function pathsChangedSince(worktreeDir: string, from: string): string[] {
  const out = git(['diff', '--name-only', '--no-renames', '-z', from, 'HEAD'], {
    cwd: worktreeDir,
  });
  return out.split('\0').filter(Boolean);
}

// The files a branch changed, compared to the base branch.
export function changedFiles(worktreeDir: string, baseRef: string): string[] {
  const out = git(['diff', '--name-only', `${baseRef}...HEAD`], { cwd: worktreeDir });
  return out.split('\n').filter(Boolean);
}

export interface DiffStat {
  files: number;
  lines: number;
}

// How big the diff is: how many files, and how many lines.
// A binary file counts as one file with zero lines.
export function diffStat(worktreeDir: string, baseRef: string): DiffStat {
  const out = git(['diff', '--numstat', `${baseRef}...HEAD`], { cwd: worktreeDir });
  let files = 0;
  let lines = 0;
  for (const line of out.split('\n')) {
    if (line.trim() === '') continue;
    const [add, del] = line.split('\t');
    files += 1;
    lines += (Number(add) || 0) + (Number(del) || 0);
  }
  return { files, lines };
}

// A push glafka's own rebase produced was rejected because origin has commits this branch does not.
// Named separately from a generic git failure because the cause and the fix are both specific: HEAD
// only ever moves here by rebasing onto the base branch, never by fetching this branch's own remote
// first, so a rejection means something ELSE reached origin for this branch — a manual `git push`, a
// second machine, a person pushing by hand — since the last time epistle looked.
export class PushRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PushRejectedError';
  }
}

const NON_FAST_FORWARD_RE = /non-fast-forward|fetch first|rejected/i;

export function push(worktreeDir: string, branch: string): void {
  // The full ref: a tag with the same short name makes `git push origin <branch>` refuse.
  const ref = `refs/heads/${branch}`;
  try {
    git(['push', '-u', 'origin', `${ref}:${ref}`], { cwd: worktreeDir });
  } catch (err) {
    const stderr = String((err as { stderr?: Buffer | string }).stderr ?? (err as Error).message);
    if (!NON_FAST_FORWARD_RE.test(stderr)) throw err;
    throw new PushRejectedError(
      `origin/${branch} has commits this branch does not — something else pushed to it since ` +
        `epistle last looked (a manual push, a second machine, someone pushing by hand).\n` +
        `  see what is there:      git -C ${worktreeDir} fetch origin && ` +
        `git -C ${worktreeDir} log --oneline HEAD..origin/${branch}\n` +
        `  if that work should be kept: merge or rebase it in yourself, then run epistle again\n` +
        `  if this rebase is the version to keep (the usual case after epistle already ran once): ` +
        `git -C ${worktreeDir} push --force-with-lease origin ${ref}:${ref}, then run epistle again`,
    );
  }
}

// Moves the branch onto the newest base branch.
// A conflict throws and needs a human, but we always put the worktree back.
export function rebaseOnto(worktreeDir: string, baseRef: string): void {
  git(['fetch', 'origin', baseRef], { cwd: worktreeDir });

  // Already on top of the base: git would print "up to date" and change nothing, so there is no
  // reason to run it. Said out loud because the case that matters is the one after a hand-rebase —
  // someone who has just resolved conflicts themselves needs to know this run did NOT redo their
  // work. A second conflict after that means the base MOVED, which is a different problem with a
  // different answer, and silence made the two look identical.
  if (isAncestor(worktreeDir, `origin/${baseRef}`)) return;

  try {
    git(['rebase', `origin/${baseRef}`], { cwd: worktreeDir });
  } catch (err) {
    const conflicts = conflictingFiles(worktreeDir);
    try {
      git(['rebase', '--abort'], { cwd: worktreeDir });
    } catch {
      // Nothing to undo, or the undo failed.
      // Either way, the error below is the one that matters.
    }
    // Only call it a conflict when files really are in conflict. A rebase also fails on a dirty
    // tree, a missing ref and an unborn branch, and naming all of those "a conflict" sends someone
    // looking for conflict markers that do not exist.
    const what =
      conflicts.length > 0
        ? `hit a conflict in ${conflicts.join(', ')}`
        : `failed (no files were left in conflict, so this is not a merge conflict)`;
    throw new Error(
      `rebase onto origin/${baseRef} ${what}, so nothing was pushed. ` +
        `The worktree has been put back the way it was.\n` +
        `  rebase it by hand:  cd ${worktreeDir} && git rebase origin/${baseRef}\n` +
        (conflicts.length > 0
          ? `    fix each file, then:  git add <file> && git rebase --continue\n` +
            `    already on ${baseRef}?  git rebase --skip   (for a commit whose content is there already)\n`
          : '') +
        `  then push again:    it will not redo the rebase you just did\n` +
        `  original error: ${(err as Error).message.split('\n')[0]}`,
    );
  }
}

// Whether `ref` is already contained in this worktree's HEAD. Exit code IS the answer here, so a
// non-zero exit is "no", not a failure to report.
export function isAncestor(worktreeDir: string, ref: string): boolean {
  try {
    git(['merge-base', '--is-ancestor', ref, 'HEAD'], { cwd: worktreeDir, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// The files git says are in conflict, so the error can name them.
function conflictingFiles(worktreeDir: string): string[] {
  try {
    return git(['diff', '--name-only', '--diff-filter=U'], { cwd: worktreeDir })
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

// The short branch name, or 'HEAD' when detached. Cut from the full ref: `rev-parse --abbrev-ref`
// answers heads/<name> when a tag has the same name.
export function currentBranch(repoRoot: string): string {
  const ref = headRef(repoRoot);
  return ref === null ? 'HEAD' : ref.replace(/^refs\/heads\//, '');
}

// The full ref HEAD is on, like refs/heads/main, or null when detached.
function headRef(worktreeDir: string): string | null {
  try {
    return git(['symbolic-ref', '-q', 'HEAD'], { cwd: worktreeDir }).trim();
  } catch (err) {
    // Exit 1 is git's answer for a detached HEAD. Anything else is a real failure.
    if ((err as { status?: number }).status === 1) return null;
    throw err;
  }
}

// Finds the main checkout, even from inside a ticket's worktree.
// Every worktree shares one git folder, and its parent is the real root.
export function findRepoRoot(): string {
  let commonDir: string;
  try {
    // stdio 'pipe' keeps git's own "fatal: not a git repository" off the terminal. Left on 'inherit' it
    // printed alongside our message, and the wrapped error repeated it a second time.
    commonDir = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      stdio: 'pipe',
    }).trim();
  } catch {
    throw new Error(
      `glafka needs to run inside a git repository, and ${process.cwd()} is not one.\n` +
        `  cd into your project, or start one here: git init && git commit --allow-empty -m init`,
    );
  }
  return path.dirname(commonDir);
}

// The commit the plan was approved on. Progress is counted from here.
export function headCommit(worktreeDir: string): string {
  return git(['rev-parse', 'HEAD'], { cwd: worktreeDir }).trim();
}

// HEAD's tree object — the exact file content, with none of the commit's own metadata (parents,
// message, author, timestamp). `worktreeCheckKey` uses this instead of the commit SHA, because two
// commits with an identical tree really did run the same checks, even when their SHAs differ.
export function headTree(worktreeDir: string): string {
  return git(['rev-parse', 'HEAD^{tree}'], { cwd: worktreeDir }).trim();
}

// How many commits since baseCommit. This is the progress number we show.
export function commitsSince(worktreeDir: string, baseCommit: string): number {
  return Number(git(['rev-list', '--count', `${baseCommit}..HEAD`], { cwd: worktreeDir }).trim());
}

// Commits since `from`, or null when git does not know that commit. A rebase
// can strip it, and answering 0 there would claim the map is fresh.
export function commitsBetween(repoRoot: string, from: string): number | null {
  if (!refExists(repoRoot, from)) return null;
  return commitsSince(repoRoot, from);
}

// Names the exact code the checks ran on. Null when we can not be sure,
// which means a dirty worktree. The commands are part of the name too.
//
// Keyed on the TREE, not the commit. `epistle` rebases before it pushes, and a rebase mints a new
// commit SHA for every commit it replays even when nothing about the code changed — proven directly
// on a real ticket: 13 commits, all rewritten, `git diff` between the before and after showing zero
// lines of difference. A commit-SHA key called that "never checked" and refused the push, on code
// that had already passed, moments after it had already passed. Checks only ever look at file
// content, never at a commit's parents or message, so the tree is the right identity for them —
// stricter than necessary was never the same as safer.
export function worktreeCheckKey(
  worktreeDir: string,
  { checksCmd = null, e2eCmd = null }: { checksCmd?: string | null; e2eCmd?: string | null } = {},
): string | null {
  if (hasUncommittedChanges(worktreeDir)) return null;
  // A clear separator, so a command with spaces does not confuse the parts.
  return [headTree(worktreeDir), checksCmd ?? '', e2eCmd ?? ''].join(' | ');
}

// The title of the newest commit, shown next to the commit count.
export function latestCommitMessage(worktreeDir: string): string {
  return git(['log', '-1', '--format=%s'], { cwd: worktreeDir }).trim();
}

// Every commit title this TICKET produced, oldest first. The coder commits after each step, so this
// list is the list of finished steps.
export function ticketCommitMessages(
  worktreeDir: string,
  baseCommit: string,
  baseRef: string | null = null,
): string[] {
  const out = git(
    ['log', '--reverse', '--format=%s', ...ticketRange(worktreeDir, baseCommit, baseRef)],
    {
      cwd: worktreeDir,
    },
  );
  return out.split('\n').filter(Boolean);
}

// How many commits this ticket produced. Same range as the titles above, and
// for the same reason — the two must never disagree.
export function ticketCommits(
  worktreeDir: string,
  baseCommit: string,
  baseRef: string | null = null,
): number {
  return Number(
    git(['rev-list', '--count', ...ticketRange(worktreeDir, baseCommit, baseRef)], {
      cwd: worktreeDir,
    }).trim(),
  );
}

// HEAD, minus the base commit, minus the base branch. `baseCommit..HEAD` alone widens every time the
// base is merged in: a branch with 13 commits of its own reported 17, four of them main's.
//
// `--no-merges` drops the merge commit, which is bookkeeping rather than a step. A `baseRef` git
// does not know is dropped, not thrown on — a missing ref would fail every caller.
function ticketRange(worktreeDir: string, baseCommit: string, baseRef: string | null): string[] {
  const args = ['--no-merges', 'HEAD', `^${baseCommit}`];
  if (baseRef && baseRef !== baseCommit && refExists(worktreeDir, baseRef)) {
    args.push(`^${baseRef}`);
  }
  return args;
}

// -------------------------------------------------------------------------- GitHub (via the gh CLI)

// gh works out the branch from the folder, so we do not pass one. The branch is already on the
// remote by the time this runs, so a failure here is "pushed, no PR" — never "nothing happened". It
// is its own error type so the caller can say that, instead of passing on `gh`'s stderr plus the
// whole PR body re-printed as a shell line.
export class PullRequestFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PullRequestFailedError';
  }
}

export function createPullRequest({
  cwd,
  title,
  body,
  base = 'main',
}: {
  cwd: string;
  title: string;
  body: string;
  base?: string;
}): string {
  try {
    const out = execFileSync(
      'gh',
      ['pr', 'create', '--title', title, '--body', body, '--base', base],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return out.trim(); // gh prints the new PR URL
  } catch (err) {
    // gh's own words, not the argv we sent it. The argv contains the entire
    // ticket body, and printing it back is what made this unreadable.
    const stderr = String((err as { stderr?: Buffer | string }).stderr ?? '').trim();
    const notInstalled = (err as NodeJS.ErrnoException).code === 'ENOENT';
    const first = stderr.split('\n')[0] ?? (err as Error).message;

    let hint: string;
    if (notInstalled) {
      hint = `  install it:  https://cli.github.com   (glafka opens PRs through \`gh\`)`;
    } else if (/auth login|GH_TOKEN|not logged in/i.test(stderr)) {
      hint = `  log in:      gh auth login`;
    } else if (/could not determine|no git remote|not a github/i.test(stderr)) {
      hint = `  this remote is not a GitHub repo, so \`gh\` cannot open a PR for it — open one by hand`;
    } else {
      hint = `  open it by hand, or fix what gh reported above`;
    }

    throw new PullRequestFailedError(
      `${notInstalled ? '`gh` is not installed' : `\`gh pr create\` failed: ${first}`}\n${hint}`,
    );
  }
}

// The URL of the OPEN pull request for this branch, or null. GitHub is asked rather than the ticket,
// because the ticket only knows what glafka itself opened: a PR opened by hand, or on a branch whose
// ticket state was rebuilt, is invisible to it and `gh pr create` would still refuse.
//
// This exists because `epistlePush` called `gh pr create` unconditionally. A second push to a branch
// that already has a PR — a retry after any mid-run failure, or simply more commits on the same
// ticket — pushed the commits successfully and THEN threw, because `gh` refuses to open a second PR
// for one branch. The work was on GitHub and the command still ended in an error, which reads as "the
// push failed" and sends people re-running the whole thing.
//
// Null on any failure, including `gh` not being installed: this only ever decides whether to SKIP
// creating a PR, so an unanswerable question has to fall through to trying, which reports its own
// error properly.
export function openPullRequestForBranch({
  cwd,
  branch,
}: {
  cwd: string;
  branch: string;
}): string | null {
  try {
    const out = execFileSync(
      'gh',
      ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'url', '--limit', '1'],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const parsed: unknown = JSON.parse(out);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const url = (parsed[0] as { url?: unknown }).url;
    return typeof url === 'string' && url !== '' ? url : null;
  } catch {
    return null;
  }
}

// Returns "OPEN", "MERGED" or "CLOSED".
// A ticket can not be closed while its PR is still open.
export function pullRequestState({ cwd, prUrl }: { cwd: string; prUrl: string }): string {
  const out = execFileSync('gh', ['pr', 'view', prUrl, '--json', 'state'], {
    cwd,
    encoding: 'utf8',
  });
  return JSON.parse(out).state;
}
