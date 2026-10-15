import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeGitRepo } from '../helpers/gitFixture.js';
import { makeTempDir } from '../helpers/tempDir.js';
import { runOdysse } from '../../installKit/bin/commands/odysse.js';
import {
  readDoc,
  writeDoc,
  ethosPath,
  architectureDir,
  workspaceProposalPath,
  workspaceDecidedPath,
  applyWorkspaceDecision,
  isolationProfilePath,
} from '../../src/memory/docsStore.js';
import { odysse, odysseFollowUp } from '../../src/commands/odysse/odysse.js';
import type { OdysseResult } from '../../src/commands/odysse/odysse.js';

// Forces the non-CBM path and narrows the return type for prompt assertions.
function odyssePromptPath(opts: { repoRoot: string }): { prompt: string } {
  const r: OdysseResult = odysse(opts);
  if (r.cbmIndexed) throw new Error('expected non-CBM path');
  return r;
}
import {
  readEthosDocs,
  decideProposals,
  promoteEthosCandidates,
  proposeEthos,
} from '../../src/memory/ethos.js';
import { loadConfig } from '../../src/config.js';
import { fileURLToPath } from 'node:url';
import { install } from '../../src/commands/install/install.js';

// Captures what a command printed, so a test can assert on the words each
// audience actually reads.
function capture(fn: () => void): string {
  const lines: string[] = [];
  const realLog = console.log;
  const realErr = console.error;
  console.log = (...a: unknown[]) => lines.push(a.join(' '));
  console.error = (...a: unknown[]) => lines.push(a.join(' '));
  try {
    fn();
  } finally {
    console.log = realLog;
    console.error = realErr;
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------

// ODYSSE_FLAGS was a hardcoded list of six, so assertKnownFlags rejected
// every category flag before the --propose dispatch could read it. The prompt tells the agent to
// file conventions this way throughout the scan, so every one of those calls died and the findings
// were lost with nothing telling the human.
test('--propose --code files the rule instead of dying on an unknown flag', () => {
  const repoRoot = makeGitRepo();

  runOdysse({
    args: ['--propose', '--code', 'errors', 'are', 'wrapped', 'at', 'the', 'boundary'],
    repoRoot,
    stateDir: makeTempDir('state'),
    config: loadConfig(repoRoot),
  });

  const doc = readDoc(ethosPath(repoRoot, 'ETHOS_CODE'));
  const proposed = doc.split('## Proposed')[1]?.split('## Learned')[0] ?? '';
  assert.match(proposed, /- errors are wrapped at the boundary/);
});

// The allowlist has to be derived from the project's categories, not a second hardcoded copy.
// A custom category proves it: nothing in glafka's source can know this flag exists.
test('a custom categories.json flag is accepted too', () => {
  const repoRoot = makeGitRepo();
  const categoriesFile = path.join(repoRoot, 'docs/glafka/ethos/categories.json');
  fs.mkdirSync(path.dirname(categoriesFile), { recursive: true });
  fs.writeFileSync(
    categoriesFile,
    JSON.stringify([{ name: 'DATA_MODEL', hint: 'table shape, keys, migrations' }]),
  );

  runOdysse({
    args: ['--propose', '--data_model', 'every', 'table', 'carries', 'a', 'tenant', 'id'],
    repoRoot,
    stateDir: makeTempDir('state'),
    config: loadConfig(repoRoot),
  });

  const doc = readDoc(ethosPath(repoRoot, 'ETHOS_DATA_MODEL'));
  assert.match(doc, /- every table carries a tenant id/);
});

// A real typo must still be refused. The fix widens the allowlist; it must not remove the guard.
test('an unknown flag is still refused, with the near-miss named', async () => {
  const repoRoot = makeGitRepo();

  await assert.rejects(
    () =>
      runOdysse({
        args: ['--propose', '--cod', 'a', 'rule'],
        repoRoot,
        stateDir: makeTempDir('state'),
        config: loadConfig(repoRoot),
      }),
    (err: Error) => {
      assert.match(err.message, /unknown flag/);
      assert.match(err.message, /did you mean --code/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------

// The prompt never said how much to write back, so a 20-minute scan buried
// the human under per-subagent dumps and running commentary restating the same facts three times.
// The report is now glafka's job, read off disk, and the prompt says so.
test('the scan prompt tells the agent not to write its own report', () => {
  const repoRoot = makeGitRepo();

  const { prompt } = odyssePromptPath({ repoRoot });

  assert.match(prompt, /What to print when you stop/);
  assert.match(prompt, /Do not write your own version of it/);
  assert.match(prompt, /Never restate a doc's contents in the terminal/);
  assert.match(prompt, /subagents.*working notes for you/s);
  assert.match(prompt, /Five lines, maximum/);
});

// The lever that makes this fix hold: every number in the report comes off disk, so a silent
// agent and a chatty one produce the same report. Asking politely for brevity could not do this.
test('glafka counts the run itself, with nothing said by the agent', () => {
  const repoRoot = makeGitRepo();
  writeDoc(path.join(architectureDir(repoRoot), 'README.md'), '# index\n');
  writeDoc(path.join(architectureDir(repoRoot), 'src', 'commands.md'), '# commands\n');
  writeDoc(path.join(architectureDir(repoRoot), 'src', 'memory', 'store.md'), '# store\n');
  fs.writeFileSync(path.join(architectureDir(repoRoot), 'isolation.json'), '{}');

  const result = odysseFollowUp({ repoRoot, ranAgent: true });

  // Nested docs counted, isolation.json seen, and it is not counted as a doc.
  assert.equal(result.docsWritten, 3);
  assert.equal(result.isolationWritten, true);
});

// Same rule the proposals already follow: with no agent run, there is nothing to report.
test('the run report stays empty when no agent actually ran', () => {
  const repoRoot = makeGitRepo();
  writeDoc(path.join(architectureDir(repoRoot), 'README.md'), '# a doc from some earlier run\n');

  const result = odysseFollowUp({ repoRoot, ranAgent: false });

  assert.equal(result.docsWritten, 0);
  assert.equal(result.isolationWritten, false);
});

// ---------------------------------------------------------------------------

// The ethos gate is one-shot: `--keep` cleared `## Proposed` either way, so
// one mistyped in-range index destroyed a rule with no undo. `--keep` itself was never broken —
// out-of-range throws before writing — but a wrong pick was unrecoverable. Now it is written down.
test('a rule you turn down is written to ## Dropped, not deleted', () => {
  const repoRoot = makeGitRepo();
  proposeEthos(repoRoot, { target: 'ETHOS_CODE', text: 'errors are wrapped at the boundary' });
  proposeEthos(repoRoot, { target: 'ETHOS_CODE', text: 'no default exports' });

  decideProposals(repoRoot, [1]);

  const doc = readDoc(ethosPath(repoRoot, 'ETHOS_CODE'));
  const section = (heading: string) => doc.split(heading)[1]?.split(/\n## /)[0] ?? '';
  assert.match(section('## Learned'), /- errors are wrapped at the boundary/);
  assert.match(section('## Dropped'), /- no default exports/);
});

// The whole point of keeping it: it must be readable without becoming policy.
test('nothing under ## Dropped is ever sent to an agent', () => {
  const repoRoot = makeGitRepo();
  proposeEthos(repoRoot, { target: 'ETHOS_CODE', text: 'errors are wrapped at the boundary' });
  proposeEthos(repoRoot, { target: 'ETHOS_CODE', text: 'no default exports' });

  decideProposals(repoRoot, [1]);

  const injected = readEthosDocs(repoRoot)!;
  assert.match(injected, /errors are wrapped at the boundary/);
  assert.doesNotMatch(injected, /no default exports/);
});

// readEthosDocs stripped only `## Proposed`, so every other heading was policy. The file's own
// header invites hand-editing, which made that a live hole long before ## Dropped existed.
test('only ## Authored and ## Learned are in force, not any other heading', () => {
  const repoRoot = makeGitRepo();
  writeDoc(
    ethosPath(repoRoot, 'ETHOS_CODE'),
    '# ETHOS_CODE\n\n## Authored\n\n- a rule I wrote\n\n## Notes\n\n- just thinking out loud\n\n## Learned\n\n- a rule I approved\n',
  );

  const injected = readEthosDocs(repoRoot)!;

  assert.match(injected, /a rule I wrote/);
  assert.match(injected, /a rule I approved/);
  assert.doesNotMatch(injected, /just thinking out loud/);
});

// "Already known" has to mean already in force, or the record of a wrong pick
// would stop you fixing it.
test('a rule under ## Dropped does not block approving it later', () => {
  const repoRoot = makeGitRepo();
  writeDoc(
    ethosPath(repoRoot, 'ETHOS_CODE'),
    '# ETHOS_CODE\n\n## Authored\n\n## Learned\n\n## Dropped\n\n- turned down once\n',
  );

  promoteEthosCandidates(repoRoot, [{ target: 'ETHOS_CODE', text: 'turned down once' }]);

  const doc = readDoc(ethosPath(repoRoot, 'ETHOS_CODE'));
  assert.match(doc.split('## Learned')[1]!.split(/\n## /)[0]!, /- turned down once/);
});

// The gate must still not ask twice — the record is what stops a re-scan re-proposing it.
test('a dropped rule is not proposed again on a later scan', () => {
  const repoRoot = makeGitRepo();
  proposeEthos(repoRoot, { target: 'ETHOS_CODE', text: 'no default exports' });
  decideProposals(repoRoot, []);

  const added = proposeEthos(repoRoot, { target: 'ETHOS_CODE', text: 'no default exports' });

  assert.equal(added, false);
});

// Same rule for the other gate: decided, but not destroyed.
test('the workspace proposal is parked, not deleted', () => {
  const repoRoot = makeGitRepo();
  writeDoc(
    workspaceProposalPath(repoRoot),
    JSON.stringify({ baseRef: 'main', bootstrapCmd: 'npm ci', seedFiles: ['.env'] }),
  );

  applyWorkspaceDecision(repoRoot, [1]);

  // Gone from the pending path, so nobody is asked twice.
  assert.equal(fs.existsSync(workspaceProposalPath(repoRoot)), false);
  // Still readable, so a wrong pick can be re-applied by hand.
  const parked = JSON.parse(readDoc(workspaceDecidedPath(repoRoot))) as Record<string, unknown>;
  assert.equal(parked.bootstrapCmd, 'npm ci');
  assert.deepEqual(parked.seedFiles, ['.env']);
});

// ---------------------------------------------------------------------------

// A ~20-minute scan gave the human silence, then unstructured prose, then a
// wall of decisions. Nothing in the prompt asked for a progress view at all.
test('the prompt asks for one checklist, kept current for the whole run', () => {
  const repoRoot = makeGitRepo();

  const { prompt } = odyssePromptPath({ repoRoot });

  assert.match(prompt, /What to print while you work/);
  assert.match(prompt, /checklist before you open a single file/);
  assert.match(prompt, /Keep it current as you go/);
  // The size answer, so an agent does not guess it at forty items.
  assert.match(prompt, /Five to ten items/);
});

// The checklist only helps if the harness redraws it. Printed, it is fifteen copies of
// itself by the end — the exact running commentary the report fix removed. Silence is the correct fallback.
test('a harness with no in-place list is told to print nothing', () => {
  const repoRoot = makeGitRepo();

  const { prompt } = odyssePromptPath({ repoRoot });

  assert.match(prompt, /redraws in place/);
  assert.match(prompt, /no such list, print nothing at all/);
  assert.match(prompt, /Never write progress as prose/);
});

// glafka installs to six platforms and ships ONE shared skill, so the progress instruction has to
// name a capability, never a tool. A tool name here would help one platform and confuse five.
test('the progress instruction names no platform tool', () => {
  const repoRoot = makeGitRepo();

  const { prompt } = odyssePromptPath({ repoRoot });

  assert.doesNotMatch(prompt, /TodoWrite/);
  assert.doesNotMatch(prompt, /Claude/i);
});

// ...but on the platform that does have one, the command must actually be allowed to use it.
test('the Claude command may use its task list', () => {
  const commandFile = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'installKit/.claude/commands/glafka/odysse.md',
  );

  const frontmatter = readDoc(commandFile).split('---')[1]!;

  assert.match(frontmatter, /TodoWrite/);
});

// ---------------------------------------------------------------------------

// Every decision odysse has was
// delivered as text plus a request to type `--keep 1,3`. glafka printed those commands itself, so
// the agent had them to hand over. It no longer does when the reader is an agent.
test('an agent is told to ask, and gets no command to hand over', () => {
  const repoRoot = makeGitRepo();
  proposeEthos(repoRoot, { target: 'ETHOS_CODE', text: 'errors are wrapped at the boundary' });

  const printed = capture(() =>
    runOdysse({
      args: ['--list'],
      repoRoot,
      stateDir: makeTempDir('state'),
      config: loadConfig(repoRoot),
      hasTty: () => false,
    }),
  );

  assert.match(printed, /Ask the person which of these to keep/);
  assert.match(printed, /Offer them as options to pick from/);
  assert.match(printed, /do not give them a command to run/);
  assert.doesNotMatch(printed, /keep all: {2}glafka odysse/);
  assert.doesNotMatch(printed, /keep none: {2}glafka odysse/);
});

// The list-and-type path is the fallback, not a regression to remove. Someone
// running the command in their own terminal needs exactly that.
test('a person at a terminal still gets commands they can type', () => {
  const repoRoot = makeGitRepo();
  proposeEthos(repoRoot, { target: 'ETHOS_CODE', text: 'errors are wrapped at the boundary' });

  const printed = capture(() =>
    runOdysse({
      args: ['--list'],
      repoRoot,
      stateDir: makeTempDir('state'),
      config: loadConfig(repoRoot),
      hasTty: () => true,
    }),
  );

  assert.match(printed, /keep all: {2}glafka odysse --keep all/);
  assert.match(printed, /keep some: glafka odysse --keep 1,3/);
  assert.doesNotMatch(printed, /Ask the person/);
});

// It is a contract for every gate, not a fix for the ethos one. The workspace
// gate is the second gate that exists today, so it is the test that it holds.
test('the workspace gate follows the same contract', () => {
  const repoRoot = makeGitRepo();
  writeDoc(workspaceProposalPath(repoRoot), JSON.stringify({ baseRef: 'main' }));

  const forAgent = capture(() =>
    runOdysse({
      args: ['--list'],
      repoRoot,
      stateDir: makeTempDir('state'),
      config: loadConfig(repoRoot),
      hasTty: () => false,
    }),
  );

  assert.match(forAgent, /glafka odysse --workspace-keep <the ones they picked>/);
  assert.doesNotMatch(forAgent, /keep all: {2}glafka odysse --workspace-keep all/);
});

// Six platforms, one shared skill file. Naming one platform's tool would help one and confuse five.
test('the skill states the contract without naming a platform tool', () => {
  const skill = readDoc(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'installKit/skills/odysse.md',
    ),
  );

  assert.match(skill, /Never hand them a command to run/);
  assert.match(skill, /whatever mechanism your harness has/);
  assert.match(skill, /now type indexes.{0,3} is a regression/);
  assert.match(skill, /They never see a number/);
  // The fallback has to survive, for a harness with no way to offer options.
  assert.match(skill, /no way to offer options/);
  assert.doesNotMatch(skill, /AskUserQuestion/);
});

// ---------------------------------------------------------------------------

// `install` vendors glafka's whole source into `.glafka/src/`, so every
// internal module is importable by relative path. When `--propose` broke, an agent read
// `.glafka/src/memory/ethos.js`, called `proposeEthos()` and wrote 13 rules. First try, no
// resistance. Nothing anywhere told it not to. This is the cheap half: say so, in every place an
// agent looking for a way around a broken command actually arrives.
test('the prompt forbids the internals and forbids routing around a failure', () => {
  const repoRoot = makeGitRepo();

  const { prompt } = odyssePromptPath({ repoRoot });

  assert.match(prompt, /Using glafka/);
  assert.match(prompt, /Never read, import or call anything under `\.glafka\/`/);
  assert.match(prompt, /If a glafka command fails, stop and say so/);
  assert.match(prompt, /Do\s+not\s+find\s+another\s+way\s+to\s+get\s+the\s+same\s+result/);
});

test('the skill carries the same invariant', () => {
  const skill = readDoc(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'installKit/skills/odysse.md',
    ),
  );

  assert.match(skill, /The CLI is the only way in/);
  assert.match(skill, /Never read, import or call anything under/);
  assert.match(skill, /If a glafka command fails, stop and report it/);
});

// A prompt is only read once, at the start. An agent that greps its way straight into the vendored
// tree twenty minutes later never sees it — so the warning has to be in the folder too.
test('a real install leaves the notice inside the vendored folder', () => {
  const targetRoot = makeTempDir('install-target');
  const packageRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

  install({ packageRoot, targetRoot, platforms: ['claude'] });

  // The module the bypass actually used must be there, or this proves nothing.
  assert.ok(fs.existsSync(path.join(targetRoot, '.glafka/src/memory/ethos.js')));
  const notice = readDoc(path.join(targetRoot, '.glafka/README.md'));
  assert.match(notice, /not an API/i);
  assert.match(notice, /node \.glafka\/bin\/glafka\.js/);
  assert.match(notice, /stop and report it/);
});

// ...and in the file itself, above each function that writes without asking anyone.
test('every ethos write point is marked in the vendored source', () => {
  const targetRoot = makeTempDir('install-target-2');
  const packageRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  install({ packageRoot, targetRoot, platforms: ['claude'] });

  const vendored = readDoc(path.join(targetRoot, '.glafka/src/memory/ethos.js'));

  for (const name of ['proposeEthos', 'promoteEthosCandidates', 'decideProposals']) {
    const at = vendored.indexOf(`function ${name}`);
    assert.notEqual(at, -1, `${name} is not in the vendored file`);
    assert.match(vendored.slice(Math.max(0, at - 300), at), /NOT AN API/, `${name} has no warning`);
  }
});

// ---------------------------------------------------------------------------

// Eight minutes into a twenty-minute scan the agent stopped and asked what
// to do about two auth bugs it had found. The answer ("a feature for later") was not needed then,
// and fixing bugs is not odysse's job. The prompt never said WHEN a human may be interrupted, so an
// alarming finding produced an interrupt because that felt responsible in the moment.
test('discovery runs to the end, whatever it turns up', () => {
  const repoRoot = makeGitRepo();

  const { prompt } = odyssePromptPath({ repoRoot });

  assert.match(prompt, /Things you find that are not the map/);
  assert.match(prompt, /Never\s+stop\s+the\s+scan\s+to\s+ask\s+about\s+one/);
  assert.match(prompt, /Severity\s+is\s+not\s+a\s+reason\s+to\s+stop/);
  // Mapping a codebase is not changing one. A bug is a ticket.
  assert.match(prompt, /Do\s+not\s+offer\s+to\s+fix\s+it/);
});

// One exception, drawn at "the scan cannot continue" rather than at "this looks serious" — a
// severity-shaped exception is the loophole every alarming finding fits through.
test('the only permitted stop is one that blocks the scan itself', () => {
  const repoRoot = makeGitRepo();

  const { prompt } = odyssePromptPath({ repoRoot });

  assert.match(prompt, /blocks the scan\s+itself/);
  assert.match(prompt, /an obstacle, not a finding/);
});

// Held back, not thrown away: one question at the very end, after every other decision.
test('the findings are offered once, after every other decision', () => {
  const repoRoot = makeGitRepo();

  const { prompt } = odyssePromptPath({ repoRoot });

  assert.match(prompt, /after every decision above is settled/);
  assert.match(prompt, /ask whether they want to go through them now/);
  assert.match(prompt, /One question, at the very end/);
});

test('the skill makes the offer its own step, before stopping', () => {
  const skill = readDoc(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'installKit/skills/odysse.md',
    ),
  );

  assert.match(skill, /## 4\. Offer the findings/);
  assert.match(skill, /## 5\. Stop/);
  assert.match(skill, /None of it is a reason to stop the scan/);
  // The offer has to come after the gates, or it is just another interrupt.
  assert.ok(skill.indexOf('## 4. Offer the findings') > skill.indexOf('## 3. Ask which'));
});

// ---------------------------------------------------------------------------

// Task 9 — `--audit` must still run compaction, not just parse. A static list/string check
// stays green even if the dispatch silently stopped routing `--audit` there.
test('--audit still runs compaction, with a deprecation notice', () => {
  const repoRoot = makeGitRepo();

  const printed = capture(() =>
    runOdysse({
      args: ['--audit'],
      repoRoot,
      stateDir: makeTempDir('state'),
      config: loadConfig(repoRoot),
    }),
  );

  assert.match(printed, /--audit is now --compact/);
  // A fresh repo has no ethos rules — this line only prints if compaction really ran.
  assert.match(printed, /nothing to compact/);
});

// ---------------------------------------------------------------------------

// The same as capture, for a command that awaits.
async function captureAsync(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const realLog = console.log;
  const realErr = console.error;
  console.log = (...a: unknown[]) => lines.push(a.join(' '));
  console.error = (...a: unknown[]) => lines.push(a.join(' '));
  try {
    await fn();
  } finally {
    console.log = realLog;
    console.error = realErr;
  }
  return lines.join('\n');
}

// Keeps a proposed checks command, at a terminal or not.
async function keepChecks(checksCmd: string, atTty: boolean) {
  const repoRoot = makeGitRepo();
  writeDoc(workspaceProposalPath(repoRoot), JSON.stringify({ checksCmd }));
  const printed = await captureAsync(() =>
    runOdysse({
      args: ['--workspace-keep', 'all'],
      repoRoot,
      stateDir: makeTempDir('state'),
      config: loadConfig(repoRoot),
      hasTty: () => atTty,
    }),
  );
  const profile = JSON.parse(readDoc(isolationProfilePath(repoRoot))) as {
    workspace?: { checksCmd?: string };
  };
  return { repoRoot, printed, saved: profile.workspace?.checksCmd };
}

// The checks probe only finds a command. glafka runs it once, for a person who kept it.
test('a checks command kept at a real terminal is run once, and its result shown', async () => {
  const { repoRoot, printed, saved } = await keepChecks('touch checks-ran.txt', true);

  assert.equal(fs.existsSync(path.join(repoRoot, 'checks-ran.txt')), true);
  assert.match(printed, /checks passed/);
  assert.equal(saved, 'touch checks-ran.txt');
});

// No terminal means an agent kept it. It must not get a way to run a command it wrote itself.
test('a checks command kept with no terminal is saved, but never run', async () => {
  const { repoRoot, printed, saved } = await keepChecks('touch checks-ran.txt', false);

  assert.equal(fs.existsSync(path.join(repoRoot, 'checks-ran.txt')), false);
  assert.match(printed, /checks command not tested/);
  assert.match(printed, /glafka checks <ticket-id>/);
  assert.equal(saved, 'touch checks-ran.txt');
});

// A failing command may still be the right one: the project itself can be broken right now.
test('a failing checks command is shown as FAILED, and still saved', async () => {
  const { printed, saved } = await keepChecks('false', true);

  assert.match(printed, /checks FAILED\. Saved anyway/);
  assert.equal(saved, 'false');
});
