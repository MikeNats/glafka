import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { makeGitRepo } from '../helpers/gitFixture.js';
import {
  genesis,
  assertUsablePlan,
  buildPlanPrompt,
  createTicket,
  attachSpec,
} from '../../src/commands/genesis/genesis.js';
import { specPath, planPath, worktreePath } from '../../src/ticket/paths.js';
import { buildErgonPrompt } from '../../src/commands/ergon/ergon.js';
import { PROJECT_POLICY_PATH } from '../../installKit/guardrails/resolve.js';
import { runBootstrap, runIsolationHook, buildBranchName } from '../../src/ticket/resources.js';
import { buildEthosCaptureSection } from '../../src/memory/ethos.js';
import { positionalId } from '../../installKit/bin/cli/args.js';
import { DEFAULT_CATEGORIES } from '../../src/memory/categories.js';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Bugs found on the first real genesis run against a fresh
// install, where nothing had ever turned guardrails on.

// These run the real built CLI, not the source. Run `npm run build` first.
const BIN = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'dist',
  'installKit',
  'bin',
  'glafka.js',
);

const stateDirFor = (repoRoot: string) => path.join(repoRoot, '.glafka');

function runCli(repoRoot: string, args: string[]): { out: string; code: number } {
  try {
    const out = execFileSync('node', [BIN, ...args], { cwd: repoRoot, encoding: 'utf8' });
    return { out, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { out: `${e.stdout ?? ''}${e.stderr ?? ''}`, code: e.status ?? 1 };
  }
}

// Turns guardrails on for a repo, which is what makes a missing claim a real
// hole rather than a state nobody asked to be in.
function setGuardrailsLevel(repoRoot: string, level: number): void {
  const filePath = path.join(repoRoot, PROJECT_POLICY_PATH);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify({ level }, null, 2)}\n`);
}

// --------------------------------------------------------------------------- 1. --claim must not fail a project that never asked for a cage

const CLAIM_SECTION = /## Do this first/;

test('the coder is not told to claim its session when guardrails are off', () => {
  const prompt = buildErgonPrompt({
    ticket: { id: '2026-08-07-add-dark-mode' },
    planContent: 'x',
    guardrailsLevel: 0,
  });

  assert.doesNotMatch(prompt, CLAIM_SECTION);
  // The instruction that turned a level-0 install into a dead stop.
  assert.doesNotMatch(prompt, /NOT claimed/);
});

test('the coder is still told to claim its session once guardrails are on', () => {
  const prompt = buildErgonPrompt({
    ticket: { id: '2026-08-07-add-dark-mode' },
    planContent: 'x',
    guardrailsLevel: 2,
  });

  assert.match(prompt, CLAIM_SECTION);
  assert.match(prompt, /guardrails --claim 2026-08-07-add-dark-mode/);
  assert.match(prompt, /NOT claimed/);
});

test('an unresolved guardrails level keeps the claim step, not drops it', () => {
  // Null is "the caller did not look". Dropping the cage on a maybe is the one
  // direction this must never fail in.
  const prompt = buildErgonPrompt({
    ticket: { id: '2026-08-07-add-dark-mode' },
    planContent: 'x',
  });

  assert.match(prompt, CLAIM_SECTION);
});

test('guardrails --claim succeeds at level 0 instead of blocking a fresh install', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = stateDirFor(repoRoot);
  const ticket = await genesis({ repoRoot, stateDir, content: 'task', planContent: '1. do it' });

  const { out, code } = runCli(repoRoot, ['guardrails', '--claim', ticket.id]);

  // Exit 0 is the whole point: the coder prompt stops on a failure here.
  assert.equal(code, 0);
  assert.match(out, /nothing to claim/);
  assert.match(out, /level 0/);
  assert.doesNotMatch(out, /NOT claimed/);
  // It must still say how to turn enforcement on, or "off" reads as "broken".
  assert.match(out, /--install-hook/);
});

test('guardrails --claim still fails hard once a project has asked for enforcement', async () => {
  const repoRoot = makeGitRepo();
  const stateDir = stateDirFor(repoRoot);
  const ticket = await genesis({ repoRoot, stateDir, content: 'task', planContent: '1. do it' });
  setGuardrailsLevel(repoRoot, 2);

  const { out, code } = runCli(repoRoot, ['guardrails', '--claim', ticket.id]);

  // A cage was asked for and is not there. That is a real hole.
  assert.equal(code, 1);
  assert.match(out, /NOT claimed/);
});

// --------------------------------------------------------------------------- 2. the guardrails state has to arrive before the work, not after it

// Splits the streams, because the whole point is that the advice is on stderr
// and the ticket id is not.
function runCliSplit(repoRoot: string, args: string[]) {
  const result = spawnSync('node', [BIN, ...args], { cwd: repoRoot, encoding: 'utf8' });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', code: result.status ?? 1 };
}

test('create says guardrails are off, at the point that is still cheap to act on', () => {
  const repoRoot = makeGitRepo();

  const { stdout, stderr, code } = runCliSplit(repoRoot, ['create', 'add a thing']);

  assert.equal(code, 0);
  assert.match(stderr, /guardrails are off/);
  assert.match(stderr, /--install-hook/);
  // A note must never block, and must never become the ticket id.
  assert.match(stdout, /^\d{4}-\d{2}-\d{2}-[a-z0-9-]+\s/);
  assert.doesNotMatch(stdout, /guardrails/);
});

test('create stays quiet once a project has decided, even if the decision is off', () => {
  const repoRoot = makeGitRepo();
  setGuardrailsLevel(repoRoot, 0);

  const { stderr } = runCliSplit(repoRoot, ['create', 'add a thing']);

  // Level 0 written down on purpose is a decision, not an oversight.
  assert.doesNotMatch(stderr, /guardrails are off/);
});

test('create warns when enforcement was asked for but no hook is wired', () => {
  const repoRoot = makeGitRepo();
  setGuardrailsLevel(repoRoot, 2);

  const { stderr, code } = runCliSplit(repoRoot, ['create', 'add a thing']);

  assert.equal(code, 0);
  assert.match(stderr, /level 2, but no hook is installed/);
  assert.match(stderr, /Nothing will be enforced/);
});

test('a project with the hook installed hears nothing at all', () => {
  const repoRoot = makeGitRepo();
  setGuardrailsLevel(repoRoot, 2);
  const settings = path.join(repoRoot, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(
    settings,
    JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: '*',
            hooks: [{ type: 'command', command: 'glafka guardrails --run-hook claude' }],
          },
        ],
      },
    }),
  );

  const { stderr } = runCliSplit(repoRoot, ['create', 'add a thing']);

  assert.doesNotMatch(stderr, /guardrails/);
});

// --------------------------------------------------------------------------- 3. a hook that hangs has to say what hung

// assert.throws hands back nothing, and the message IS what is under test here.
function caught(fn: () => unknown): Error & { code?: string; killed?: boolean } {
  try {
    fn();
  } catch (err) {
    return err as Error & { code?: string; killed?: boolean };
  }
  throw new Error('expected this to throw, and it did not');
}

test('a timed-out hook names the command, the folder, and how long it ran', () => {
  const err = caught(() =>
    runBootstrap('echo starting up && sleep 30', {
      cwd: process.cwd(),
      env: {},
      timeout: 300,
    }),
  );

  // "spawnSync /bin/sh ETIMEDOUT" said none of this.
  assert.match(err.message, /bootstrapCmd timed out after/);
  assert.match(err.message, /limit: 300ms/);
  assert.match(err.message, new RegExp(`cwd: ${process.cwd()}`));
  assert.match(err.message, /cmd: echo starting up && sleep 30/);
  // What it managed to print before it hung is the thing that locates the hang.
  assert.match(err.message, /starting up/);
  assert.match(err.message, /Raise the limit/);
});

test('a hook that fails fast reports its exit code, not a timeout', () => {
  const err = caught(() =>
    runIsolationHook('echo nope >&2; exit 3', { cwd: process.cwd(), env: {} }),
  );

  assert.match(err.message, /setupCmd failed after/);
  assert.match(err.message, /exit 3/);
  assert.match(err.message, /nope/);
  // A plain failure has no limit to raise.
  assert.doesNotMatch(err.message, /Raise the limit/);
});

test('each configured hook is named by the key it was configured under', () => {
  const err = caught(() =>
    runIsolationHook('exit 1', { cwd: process.cwd(), env: {}, label: 'e2e.setupCmd' }),
  );

  assert.match(err.message, /^e2e\.setupCmd failed/);
});

test('a rebuilt hook error still carries the timeout signal', () => {
  const err = caught(() => runBootstrap('sleep 30', { cwd: process.cwd(), env: {}, timeout: 300 }));

  // src/checks.ts and bin/commands/ergon.ts both read these to tell a timeout
  // apart from a plain failure. A nicer message must not cost them that.
  assert.equal(err.code === 'ETIMEDOUT' || err.killed === true, true);
  assert.equal(err.cause !== undefined, true);
});

test('a hook that prints nothing at all says so rather than showing a blank', () => {
  const err = caught(() => runIsolationHook('exit 1', { cwd: process.cwd(), env: {} }));

  assert.match(err.message, /it printed nothing before it stopped/);
});

// --------------------------------------------------------------------------- 4. nothing may tell an agent to run a command the CLI refuses it

const ETHOS_SECTION = buildEthosCaptureSection({
  ticketId: '2026-08-07-add-dark-mode',
  stage: 'planning',
  categories: DEFAULT_CATEGORIES,
});

test('the ethos prompt never hands an agent the one flag it cannot use', () => {
  // psyche.ts refuses --from you without a TTY, and the check is right: an
  // agent cannot certify that a person said something. The instruction was wrong.
  assert.doesNotMatch(ETHOS_SECTION, /psyche [^\n]*--from you/);
});

test('the ethos prompt says why the flag is not theirs to use', () => {
  // Silence would just get it guessed at again.
  assert.match(ETHOS_SECTION, /Do not reach for `--from you`/);
  assert.match(ETHOS_SECTION, /real terminal/);
});

test('recording what the human said is still urgent, not downgraded', () => {
  // The fix was to drop a flag, not to soften the instruction around it.
  assert.match(ETHOS_SECTION, /When the human states a preference/);
  assert.match(ETHOS_SECTION, /record it immediately/);
});

test('the genesis skill does not tell an agent to use --from you either', () => {
  const skill = fs.readFileSync(path.join(REPO_ROOT, 'installKit', 'skills', 'genesis.md'), 'utf8');

  assert.doesNotMatch(skill, /psyche [^\n]*--from you/);
  assert.match(skill, /No `--from` flag/);
});

// --------------------------------------------------------------------------- 5. the plan is a document with a known shape, approved as one

const PLAN_PROMPT = buildPlanPrompt('the approved spec', { ticketId: '2026-08-07-add-dark-mode' });

test('the plan prompt asks for a fixed set of headings', () => {
  // Two runs used to be free to look nothing alike.
  for (const heading of [
    '# <title> — Implementation Plan',
    '**Goal:**',
    '**Architecture:**',
    '## Global Constraints',
    '## Task 1:',
    '## Manual verification',
  ]) {
    assert.equal(PLAN_PROMPT.includes(heading), true, heading);
  }
  assert.match(PLAN_PROMPT, /- \[ \]/);
});

test('the plan prompt names where the plan goes, like the spec prompt does', () => {
  assert.match(PLAN_PROMPT, /docs\/glafka\/tickets\/2026-08-07-add-dark-mode\/plan\.md/);
});

test('the plan prompt says nothing about a path when there is no id to build one from', () => {
  assert.doesNotMatch(buildPlanPrompt('the approved spec'), /docs\/glafka\/tickets/);
});

test('an empty plan is refused before anything is provisioned', () => {
  const err = caught(() => assertUsablePlan('   \n\n  ', '/tmp/plan.md'));

  assert.match(err.message, /is empty/);
});

test('a plan with no trackable steps is allowed through, with a note', () => {
  // A terse plan someone meant is still theirs to approve. The shape is asked
  // for where the plan is written, not policed after the fact.
  const notes: string[] = [];
  const realError = console.error;
  console.error = (msg: string) => notes.push(msg);
  try {
    assertUsablePlan('just do the thing', '/tmp/plan.md');
  } finally {
    console.error = realError;
  }

  assert.match(notes.join('\n'), /no `## Task N` heading and no `- \[ \]` step/);
});

test('a plan in the asked-for shape passes without a word', () => {
  const notes: string[] = [];
  const realError = console.error;
  console.error = (msg: string) => notes.push(msg);
  try {
    assertUsablePlan('## Task 1: do it\n\n- [ ] **Step 1: write the test**\n', '/tmp/plan.md');
  } finally {
    console.error = realError;
  }

  assert.equal(notes.length, 0);
});

test('the genesis skill approves the document, not a chat dump', () => {
  const skill = fs.readFileSync(path.join(REPO_ROOT, 'installKit', 'skills', 'genesis.md'), 'utf8');

  assert.match(skill, /docs\/glafka\/tickets\/<id>\/plan\.md/);
  assert.match(skill, /clickable relative link/);
  assert.match(skill, /Don't paste the plan body into the conversation/);
});

// --------------------------------------------------------------------------- 6. a path a person is shown has to be clickable

test('every skill that reports to a person says paths are links', () => {
  // The reported path was `docs/glafka/plans/t-57faff1d.md.` — bare, and with a
  // trailing period that would have broken the link even if one had been used.
  for (const name of ['genesis', 'ergon', 'heureka', 'epistle']) {
    const skill = fs.readFileSync(
      path.join(REPO_ROOT, 'installKit', 'skills', `${name}.md`),
      'utf8',
    );
    assert.match(skill, /put in front of a person is a link/, name);
    assert.match(skill, /never a bare path/, name);
    // The trailing-punctuation trap is the half that is easy to leave out.
    assert.match(skill, /trailing punctuation outside the link/, name);
  }
});

test('odysse is left alone, because it is told not to write a report at all', () => {
  const skill = fs.readFileSync(path.join(REPO_ROOT, 'installKit', 'skills', 'odysse.md'), 'utf8');

  assert.match(skill, /\*\*Do not write a report\.\*\*/);
  assert.doesNotMatch(skill, /put in front of a person is a link/);
});

// --------------------------------------------------------------------------- 7. a folder of committed docs must not read as a list of hashes

test('a ticket doc sits in a folder named by the id, which reads as words', () => {
  const repoRoot = makeGitRepo();
  const stateDir = stateDirFor(repoRoot);
  const created = createTicket({ stateDir, repoRoot, content: 'stop the hardcoded OTP' });
  const specFile = path.join(repoRoot, 'spec.md');
  fs.writeFileSync(specFile, '# the spec\n');

  const updated = attachSpec({
    stateDir,
    repoRoot,
    id: created.id,
    specPath: specFile,
    title: 'Add dark mode to settings',
  });

  assert.match(created.id, /^\d{4}-\d{2}-\d{2}-stop-the-hardcoded-otp$/);
  assert.equal(path.basename(path.dirname(updated.specPath!)), created.id);
  assert.equal(path.basename(updated.specPath!), 'spec.md');
});

test('every path a person sees is the id, with nothing appended', () => {
  const repoRoot = makeGitRepo();
  const id = '2026-08-07-a-doc-named-by-its-id';

  assert.equal(path.basename(path.dirname(specPath(repoRoot, id))), id);
  assert.equal(path.basename(path.dirname(planPath(repoRoot, id))), id);
  assert.equal(path.basename(worktreePath(repoRoot, id)), id);
  assert.equal(buildBranchName(id), `glafka/${id}`);
});

test('renaming the title leaves one doc behind, not two', () => {
  // The filename comes from the id, and the id never changes, so a second
  // spec overwrites rather than orphaning the first name.
  const repoRoot = makeGitRepo();
  const stateDir = stateDirFor(repoRoot);
  const created = createTicket({ stateDir, repoRoot, content: 'a thing' });
  const specFile = path.join(repoRoot, 'spec.md');
  fs.writeFileSync(specFile, '# the spec\n');

  attachSpec({ stateDir, repoRoot, id: created.id, specPath: specFile, title: 'First name' });
  const renamed = attachSpec({
    stateDir,
    repoRoot,
    id: created.id,
    specPath: specFile,
    title: 'Second name',
  });

  const docsDir = path.dirname(specPath(repoRoot, created.id));
  assert.deepEqual(fs.readdirSync(docsDir), ['spec.md']);
  assert.equal(renamed.specPath!, specPath(repoRoot, created.id));
});

// --------------------------------------------------------------------------- 8. asking for help is not a typo

test('--help on a subcommand is help, not an unknown-flag error', () => {
  const repoRoot = makeGitRepo();

  for (const command of ['guardrails', 'ergon', 'plan', 'epistle', 'lysis']) {
    const { stdout, stderr, code } = runCliSplit(repoRoot, [command, '--help']);

    assert.equal(code, 0, command);
    assert.match(stdout, new RegExp(`usage: glafka ${command}`), command);
    // The three things that made it read as the person's mistake.
    assert.doesNotMatch(stdout + stderr, /unknown flag/, command);
    assert.doesNotMatch(stdout + stderr, /nothing was changed/, command);
    assert.doesNotMatch(stdout + stderr, /did you mean/, command);
  }
});

test('-h is the same as --help', () => {
  const repoRoot = makeGitRepo();

  const { stdout, code } = runCliSplit(repoRoot, ['guardrails', '-h']);

  assert.equal(code, 0);
  assert.match(stdout, /usage: glafka guardrails/);
});

test('psyche gets help too, though it never reached the shared check', () => {
  const repoRoot = makeGitRepo();

  const { stdout, code } = runCliSplit(repoRoot, ['psyche', '--help']);

  assert.equal(code, 0);
  assert.match(stdout, /usage: glafka psyche/);
});

test('a real typo is still an error, and still guesses what was meant', () => {
  const repoRoot = makeGitRepo();

  const { stderr, code } = runCliSplit(repoRoot, ['ergon', '--stats']);

  assert.equal(code, 1);
  assert.match(stderr, /unknown flag/);
  assert.match(stderr, /did you mean --status\?/);
});

test('a free-text command reads --help as help only when it is the whole argument', () => {
  const repoRoot = makeGitRepo();

  const bare = runCliSplit(repoRoot, ['create', '--help']);
  assert.equal(bare.code, 0);
  assert.match(bare.stdout, /usage: glafka create/);

  // "--help" inside a sentence is what the ticket is about, not a request.
  const inSentence = runCliSplit(repoRoot, ['create', 'document the --help flag']);
  assert.equal(inSentence.code, 0);
  assert.match(inSentence.stdout, /^\d{4}-\d{2}-\d{2}-[a-z0-9-]+\s/);
});

test('plan reports the guardrails state before it provisions anything', () => {
  const repoRoot = makeGitRepo();
  const created = runCliSplit(repoRoot, ['create', 'add a thing']);
  const id = created.stdout.split(/\s/)[0];
  const planFile = path.join(repoRoot, 'plan.md');
  fs.writeFileSync(planFile, '1. do it\n');
  runCliSplit(repoRoot, ['spec', id, planFile, '--title', 'A thing']);

  const { stderr, code } = runCliSplit(repoRoot, ['plan', id, planFile]);

  assert.equal(code, 0);
  assert.match(stderr, /guardrails are off/);
});

// --------------------------------------------------------------------------- finding the id among the flags

const ARG_ID = '2026-08-07-add-dark-mode-to-settings';

test('the id is found wherever it sits among the flags', () => {
  assert.equal(positionalId([ARG_ID, '--review']), ARG_ID);
  assert.equal(positionalId(['--review', ARG_ID]), ARG_ID);
  assert.equal(positionalId(['--keep', 'all', ARG_ID], { single: ['--keep'] }), ARG_ID);
});

test('a flag value shaped like words is not mistaken for the id', () => {
  // --level 2 and --explain filesystem are values, not ids.
  assert.equal(positionalId(['--level', '2', ARG_ID], { single: ['--level'] }), ARG_ID);
  assert.equal(positionalId(['--explain', 'filesystem'], { single: ['--explain'] }), undefined);
});

test('the id wins over a plain word that is really a flag value', () => {
  // Nothing declares --explain here, so the fallback would take "filesystem".
  // Matching the id's shape first is what stops that.
  assert.equal(positionalId(['--explain', 'filesystem', ARG_ID]), ARG_ID);
});

// --------------------------------------------------------------------------- The design reply.
// Step 4 gives the plan a fixed shape, and says why: a document a person approves that looks
// different every time is one they have to re-learn every time. The reply one step earlier — "here
// is the design, does this look right?" — is the one the whole ticket hangs on, and had no shape.

function skillText(name: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, 'installKit', 'skills', `${name}.md`), 'utf8');
}

test('genesis gives the design reply a shape, before the spec is written', () => {
  const skill = skillText('genesis');
  const design = skill.slice(skill.indexOf('## 2. Brainstorm'), skill.indexOf('## 3. Record'));

  for (const rule of [
    /Code first, prose after/,
    /One numbered item per change/,
    /Always name the rejected option/,
    /Out of scope is stated, not implied/,
    /One closing question/,
  ]) {
    assert.match(design, rule);
  }
});

// The rule that keeps a persona and a skill from shaping the same text.
test('the design shape says a persona changes wording, never the sections', () => {
  assert.match(skillText('genesis'), /never changes which sections there\s+are/);
});

// heureka puts a direction back to a person too, and looser is not the same as shapeless.
test('heureka points at the same shape, and says where it differs', () => {
  const skill = skillText('heureka');

  assert.match(skill, /genesis`'s design shape/);
  assert.match(skill, /may be "unknown yet"/);
  assert.match(skill, /leaving the heading out is not/);
});
