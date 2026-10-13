import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDir } from '../helpers/tempDir.js';
import {
  sessionSizeWarning,
  SESSION_SIZE_WARN_BYTES,
} from '../../installKit/guardrails/sessionSize.js';
import { AgentToolHookPayloadSchema } from '../../installKit/guardrails/types/hookPayload.js';

function transcriptOf(bytes: number): string {
  const filePath = path.join(makeTempDir('transcript'), 'transcript.jsonl');
  fs.writeFileSync(filePath, 'x'.repeat(bytes));
  return filePath;
}

test('a small transcript says nothing', () => {
  const stateDir = makeTempDir('state');
  const warning = sessionSizeWarning({
    stateDir,
    sessionId: 'abc123',
    transcriptPath: transcriptOf(1024),
  });
  assert.equal(warning, null);
});

test('a large transcript warns, and names a size', () => {
  const stateDir = makeTempDir('state');
  const warning = sessionSizeWarning({
    stateDir,
    sessionId: 'abc123',
    transcriptPath: transcriptOf(SESSION_SIZE_WARN_BYTES + 1),
  });
  assert.match(warning!, /MB/);
});

test('it warns once, not on every tool call', () => {
  const stateDir = makeTempDir('state');
  const transcriptPath = transcriptOf(SESSION_SIZE_WARN_BYTES + 1);
  const args = { stateDir, sessionId: 'abc123', transcriptPath };

  assert.notEqual(sessionSizeWarning(args), null);
  assert.equal(sessionSizeWarning(args), null);
  assert.equal(sessionSizeWarning(args), null);
});

test('a different session gets its own warning', () => {
  const stateDir = makeTempDir('state');
  const transcriptPath = transcriptOf(SESSION_SIZE_WARN_BYTES + 1);

  assert.notEqual(sessionSizeWarning({ stateDir, sessionId: 'one', transcriptPath }), null);
  assert.notEqual(sessionSizeWarning({ stateDir, sessionId: 'two', transcriptPath }), null);
});

test('no transcript path says nothing', () => {
  const stateDir = makeTempDir('state');
  assert.equal(sessionSizeWarning({ stateDir, sessionId: 'abc123', transcriptPath: null }), null);
});

test('a transcript path that does not exist says nothing', () => {
  const stateDir = makeTempDir('state');
  assert.equal(
    sessionSizeWarning({
      stateDir,
      sessionId: 'abc123',
      transcriptPath: '/nowhere/transcript.jsonl',
    }),
    null,
  );
});

test('no session id says nothing, because once-only cannot be tracked', () => {
  const stateDir = makeTempDir('state');
  assert.equal(
    sessionSizeWarning({
      stateDir,
      sessionId: null,
      transcriptPath: transcriptOf(SESSION_SIZE_WARN_BYTES + 1),
    }),
    null,
  );
});

test('a session id that could reach outside the state dir says nothing', () => {
  const stateDir = makeTempDir('state');
  assert.equal(
    sessionSizeWarning({
      stateDir,
      sessionId: '../../escape',
      transcriptPath: transcriptOf(SESSION_SIZE_WARN_BYTES + 1),
    }),
    null,
  );
});

test('a payload with no transcript_path still parses', () => {
  const result = AgentToolHookPayloadSchema.safeParse({ tool_name: 'Read', cwd: '/tmp' });
  assert.equal(result.success, true);
});

test('transcript_path is read when it is there', () => {
  const result = AgentToolHookPayloadSchema.safeParse({
    tool_name: 'Read',
    transcript_path: '/tmp/transcript.jsonl',
  });
  assert.equal(result.success, true);
  assert.equal(result.data!.transcript_path, '/tmp/transcript.jsonl');
});
