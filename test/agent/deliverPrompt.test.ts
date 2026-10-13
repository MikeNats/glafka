import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { deliverPrompt } from '../../installKit/bin/agent/deliverPrompt.js';
import { loadLevel } from '../../installKit/guardrails/resolve.js';
import type { Policy } from '../../installKit/guardrails/types/policy.js';
import { makeTempDir } from '../helpers/tempDir.js';
import { readRunRecords } from '../../src/audit/record.js';
import { withoutAgentCmd } from '../helpers/noAgentEnv.js';

// These tests need no agent configured. Cleared here, so running this file directly is safe too.
withoutAgentCmd();

function tempWorktree() {
  return fs.realpathSync(makeTempDir('deliver-wt'));
}

// The scratch directories deliverPrompt makes, counted where it makes them.
function countDeliverDirs(): number {
  return fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('glafka-deliver-')).length;
}

// `deliverPrompt` is the only place that runs an agent against a ticket's own
// worktree without buildEnv() or cage(). With no policy passed it must keep working exactly as before (nothing to regress); with a policy passed, the run must actually be caged the same way spawnBackground already cages the background path.

test('no policy passed: behaves exactly as before — prints and runs uncaged, unchanged', async () => {
  const worktree = tempWorktree();
  const outFile = path.join(worktree, 'out.txt');
  const prev = process.env.GLAFKA_AGENT_CMD;
  process.env.GLAFKA_AGENT_CMD = `printenv SECRET_VAL > ${JSON.stringify(outFile)}`;
  process.env.SECRET_VAL = 'topsecret';
  try {
    const ran = await deliverPrompt('irrelevant prompt', { cwd: worktree });
    assert.equal(ran, true);
    assert.equal(fs.readFileSync(outFile, 'utf8').trim(), 'topsecret');
  } finally {
    if (prev === undefined) delete process.env.GLAFKA_AGENT_CMD;
    else process.env.GLAFKA_AGENT_CMD = prev;
    delete process.env.SECRET_VAL;
  }
});

test('a policy passed in: buildEnv actually filters the child env, a secret not on keepEnv never reaches it', async () => {
  const worktree = tempWorktree();
  const outFile = path.join(worktree, 'out.txt');
  const prev = process.env.GLAFKA_AGENT_CMD;
  process.env.GLAFKA_AGENT_CMD = `printenv SECRET_VAL > ${JSON.stringify(outFile)} 2>&1 || true`;
  process.env.SECRET_VAL = 'topsecret';
  try {
    const policy: Policy = loadLevel(2); // secrets.enabled: true, sandbox.enabled: false
    const ran = await deliverPrompt('irrelevant prompt', { cwd: worktree, policy });
    assert.equal(ran, true);
    const out = fs.readFileSync(outFile, 'utf8');
    assert.equal(out.includes('topsecret'), false, 'the secret must not reach the child env');
  } finally {
    if (prev === undefined) delete process.env.GLAFKA_AGENT_CMD;
    else process.env.GLAFKA_AGENT_CMD = prev;
    delete process.env.SECRET_VAL;
  }
});

test('a policy that asks for a sandbox that cannot start refuses to run at all, same as spawnBackground', async () => {
  const worktree = tempWorktree();
  const prev = process.env.GLAFKA_AGENT_CMD;
  process.env.GLAFKA_AGENT_CMD = 'true';
  try {
    const base = loadLevel(4);
    const policy = {
      ...base,
      sandbox: { ...base.sandbox, backend: 'podman' },
    } as unknown as Policy;
    await assert.rejects(
      () => deliverPrompt('irrelevant prompt', { cwd: worktree, policy }),
      /refusing to run the agent uncaged/,
    );
  } finally {
    if (prev === undefined) delete process.env.GLAFKA_AGENT_CMD;
    else process.env.GLAFKA_AGENT_CMD = prev;
  }
});

test('a policy passed in requires cwd, matching spawnBackground', async () => {
  const prev = process.env.GLAFKA_AGENT_CMD;
  process.env.GLAFKA_AGENT_CMD = 'true';
  try {
    const policy = loadLevel(2);
    await assert.rejects(() => deliverPrompt('irrelevant prompt', { policy }), /cwd is required/);
  } finally {
    if (prev === undefined) delete process.env.GLAFKA_AGENT_CMD;
    else process.env.GLAFKA_AGENT_CMD = prev;
  }
});

// The scratch dir made for the agent's TMPDIR was never
// removed. Six per ticket, under a name no glafka command knows.

test('the scratch directory it makes for the agent is removed when the agent exits', async () => {
  const worktree = tempWorktree();
  const before = countDeliverDirs();
  const prev = process.env.GLAFKA_AGENT_CMD;
  process.env.GLAFKA_AGENT_CMD = 'true';
  try {
    const policy = loadLevel(2);
    for (let i = 0; i < 3; i++) await deliverPrompt('irrelevant prompt', { cwd: worktree, policy });
    assert.equal(countDeliverDirs(), before, 'three calls must leave nothing behind');
  } finally {
    if (prev === undefined) delete process.env.GLAFKA_AGENT_CMD;
    else process.env.GLAFKA_AGENT_CMD = prev;
  }
});

// A failing agent is the case that matters most: it is the run that leaves the most scratch, and
// the one where an early `return` would have skipped the cleanup.
test('the scratch directory is removed even when the agent exits non-zero', async () => {
  const worktree = tempWorktree();
  const before = countDeliverDirs();
  const prev = process.env.GLAFKA_AGENT_CMD;
  process.env.GLAFKA_AGENT_CMD = 'exit 3';
  try {
    const policy = loadLevel(2);
    await assert.rejects(() => deliverPrompt('irrelevant prompt', { cwd: worktree, policy }));
    assert.equal(countDeliverDirs(), before, 'a failed run must not leave its scratch behind');
  } finally {
    if (prev === undefined) delete process.env.GLAFKA_AGENT_CMD;
    else process.env.GLAFKA_AGENT_CMD = prev;
  }
});

// This path used to inherit stdout, so glafka never saw a word of the agent's
// output and every run it recorded had `tokens: null`. It pipes now, and echoes
// what it reads — an agent that says nothing is measured as having said nothing,
// which is not the same as never having been listened to.
test('a delivered prompt records the response it actually saw', async () => {
  const stateDir = makeTempDir('deliver');

  await deliverPrompt('hello agent', {
    agentCmd: 'true',
    stateDir,
    ticketId: null,
    stage: 'odysse',
    observability: true,
  });

  const [rec] = readRunRecords(stateDir, null);
  assert.equal(rec!.stage, 'odysse');
  assert.equal(rec!.promptBytes, Buffer.byteLength('hello agent'));
  // Measured and empty, not unmeasured. `true` prints nothing.
  assert.equal(rec!.responseBytes, 0);
  // Nothing said its usage, so there is still nothing to count.
  assert.equal(rec!.tokens, null);
  assert.equal(rec!.tokenSource, null);
  assert.ok(rec!.durationMs !== null && rec!.durationMs >= 0);
});

// THE POINT OF THE WHOLE FIX. epistle runs two agents on every push and
// reported no cost for either, because nothing ever read their output.
test('an agent that reports its usage has its tokens recorded', async () => {
  const stateDir = makeTempDir('deliver');
  const line = JSON.stringify({
    type: 'result',
    result: 'done',
    usage: { input_tokens: 1200, output_tokens: 340 },
  });

  await deliverPrompt('hello agent', {
    agentCmd: `printf '%s\\n' ${JSON.stringify(line)}`,
    stateDir,
    ticketId: null,
    stage: 'epistle',
    observability: true,
  });

  const [rec] = readRunRecords(stateDir, null);
  assert.deepEqual(rec!.tokens, { in: 1200, out: 340 });
  assert.equal(rec!.responseBytes, Buffer.byteLength(`${line}\n`));
});

// stream-json is what an agent has to be asked for before it reports usage at
// all, and raw JSON scrolling past is not something anyone can watch. What is
// echoed is the words inside it; what is RECORDED is the whole raw line.
test('what the agent says is echoed as prose, not as raw stream-json', async () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'checking the plan doc' }] },
  });
  const written: string[] = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await deliverPrompt('hello agent', {
      agentCmd: `printf '%s\\n' ${JSON.stringify(line)}`,
    });
  } finally {
    process.stdout.write = realWrite;
  }

  // The test runner writes its own reporting to this same stream, so what is
  // asserted is what reached it and what did NOT.
  const echoed = written.join('');
  assert.ok(echoed.endsWith('checking the plan doc\n'), echoed);
  assert.equal(echoed.includes('"type":"assistant"'), false, 'raw stream-json must not be shown');
});

// A failing agent is the run an audit reader most needs to find — recording
// null here would make it indistinguishable from a run that never started.
test('a failing agent records its real exit code, not null', async () => {
  const stateDir = makeTempDir('deliver');

  await assert.rejects(() =>
    deliverPrompt('hello agent', {
      agentCmd: 'exit 7',
      stateDir,
      ticketId: null,
      stage: 'odysse',
      observability: true,
    }),
  );

  const [rec] = readRunRecords(stateDir, null);
  assert.equal(rec!.exitCode, 7);
});

// Printing the prompt IS the run — the session carries it out. Recorded as a
// hand-over, because nothing else ever will: no process starts, so nothing
// finishes. Without this the whole brainstorm-and-plan half of a ticket, and
// every step done by hand, left no trace at all.
test('with no agent configured the hand-over is recorded', async () => {
  const stateDir = makeTempDir('deliver');

  await deliverPrompt('hello', { agentCmd: null, stateDir, ticketId: null, observability: true });

  const [rec] = readRunRecords(stateDir, null);
  assert.equal(rec!.agent, 'session');
  assert.equal(rec!.promptBytes, Buffer.byteLength('hello'));
  // Nothing ran, so nothing was timed, sized or counted.
  assert.equal(rec!.durationMs, null);
  assert.equal(rec!.exitCode, null);
  assert.equal(rec!.responseBytes, null);
  assert.equal(rec!.tokens, null);
});

test('a hand-over records nothing when observability is off', async () => {
  const stateDir = makeTempDir('deliver');

  await deliverPrompt('hello', { agentCmd: null, stateDir, ticketId: null, observability: false });

  assert.deepEqual(readRunRecords(stateDir, null), []);
});

// --------------------------------------------------------------------------- Handing over.
// The prompt is written FOR a subagent. With none to spawn it lands in front of the session's own
// agent with nothing saying whose job it now is: one read `run=not-started`, called the review
// blocked, and stopped — with the entire brief already on its screen.

// Captures both streams, since the prompt goes to stdout and notes to stderr.
async function captureDeliver(role: 'reviewer' | 'coder' | 'reporter') {
  const out: string[] = [];
  const err: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...args: unknown[]) => out.push(args.join(' '));
  console.error = (...args: unknown[]) => err.push(args.join(' '));
  try {
    await deliverPrompt('REVIEW THIS DIFF', { agentCmd: null, role });
  } finally {
    console.log = realLog;
    console.error = realError;
  }
  return { out: out.join('\n'), err: err.join('\n') };
}

test('with no subagent to spawn, the reviewer prompt is handed to whoever is reading', async () => {
  const { out, err } = await captureDeliver('reviewer');

  assert.match(err, /THIS REVIEW IS YOURS/);
  // The stop was caused by believing something had failed. Both must be denied by name.
  assert.match(err, /nothing failed/);
  assert.match(err, /nothing to wait for/);
  // The prompt itself stays on stdout, unchanged, so it can still be piped.
  assert.equal(out, 'REVIEW THIS DIFF');
});

test('the coder and reporter get the same handover, in their own words', async () => {
  assert.match((await captureDeliver('coder')).err, /THIS WORK IS YOURS/);
  assert.match((await captureDeliver('reporter')).err, /THIS IS YOURS/);
});
