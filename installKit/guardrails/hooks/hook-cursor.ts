#!/usr/bin/env node
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

import { evaluateFromCwd } from '../core.js';
import type { Action } from '../types/action.js';

// Cursor's hooks for shell commands and file reads. The real logic lives in core.js.

// Cursor's own message shape. Its fields really do change per event,
// so we keep it in this file.
const CursorHookPayloadSchema = z.object({
  hook_event_name: z.string().optional(),
  command: z.string().optional(),
  file_path: z.string().optional(),
  path: z.string().optional(),
  tool_name: z.string().optional(),
  edits: z.unknown().optional(),
  cwd: z.string().optional(),
});
type CursorHookPayload = z.infer<typeof CursorHookPayloadSchema>;

function fail(reason: string): void {
  process.stdout.write(`${JSON.stringify({ permission: 'deny', agent_message: reason })}\n`);
  process.stderr.write(`${reason}\n`);
  process.exit(2);
}

function pass(): void {
  process.stdout.write(`${JSON.stringify({ permission: 'allow' })}\n`);
  process.exit(0);
}

function readStdin(): string {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

// Turns a Cursor event into an action our layers understand.
export function toActions(payload: CursorHookPayload): Action[] {
  switch (payload.hook_event_name) {
    case 'beforeShellExecution':
      return [{ op: 'exec', commandString: payload.command ?? '' }];
    case 'beforeReadFile':
      return [{ op: 'read', filePath: payload.file_path ?? payload.path ?? null }];
    // Cursor has no BEFORE-write hook at all, so this one fires after the write has already landed
    // and cannot block it. It is modelled anyway, as a DETECTOR: the decision is
    // recorded in the audit log, so a ticket whose coder wrote outside its worktree can be refused
    // later.
    case 'afterFileEdit':
      return [{ op: 'write', filePath: payload.file_path ?? payload.path ?? null, content: '' }];
    case 'beforeMCPExecution':
      // MCP tools differ too much to translate, so we pass the name on.
      return [{ op: String(payload.tool_name ?? 'mcp') }];
    default:
      return [{ op: String(payload.hook_event_name ?? 'unknown') }];
  }
}

// Events that have already happened. Refusing them changes nothing, so the exit code stays 0 — but
// the action still goes through evaluateFromCwd, which is what puts it in the audit log.
const AFTER_THE_FACT = new Set(['afterFileEdit']);

export function main(): void {
  const raw = readStdin();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw || '{}');
  } catch {
    fail(
      'guardrails: could not read the hook payload — denying, because an unreadable request is not an approved one',
    );
    return;
  }

  const result = CursorHookPayloadSchema.safeParse(parsed);
  if (!result.success) {
    fail(
      `guardrails: hook payload does not match the expected shape (${result.error.message}) — denying`,
    );
    return;
  }
  const payload = result.data;

  const cwd = payload.cwd || process.cwd();

  const evalResult = evaluateFromCwd({ cwd, baseActions: toActions(payload) });
  // We test for the field, not the boolean. See hook.ts for why.
  if ('reason' in evalResult) {
    if (AFTER_THE_FACT.has(payload.hook_event_name ?? '')) {
      // Already written. Say so loudly on stderr and record it, but do not
      // pretend it was stopped.
      process.stderr.write(
        `guardrails [${evalResult.layer ?? 'policy'}]: ${evalResult.reason}\n` +
          `  NOT BLOCKED — Cursor has no before-write hook, so this write already landed.\n`,
      );
      pass();
      return;
    }
    fail(`guardrails [${evalResult.layer ?? 'policy'}]: ${evalResult.reason}`);
    return;
  }
  pass();
}

// Run main() only when this file is run directly.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch (err) {
    fail(`guardrails: internal error (${(err as Error).message}) — denying`);
  }
}
