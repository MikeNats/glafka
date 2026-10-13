#!/usr/bin/env node
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

import { evaluateFromCwd } from '../core.js';
import {
  AgentToolHookPayloadSchema,
  firstString,
  searchActions,
  unknownToolActions,
} from '../types/hookPayload.js';
import type { Action } from '../types/action.js';

// Kimi's hook, run before each tool. The real logic lives in core.js.
// LESS TESTED, and like Cursor, Kimi ALLOWS the action if this hook crashes.

function fail(reason: string): void {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: reason },
    })}\n`,
  );
  process.stderr.write(`${reason}\n`);
  process.exit(2);
}

function pass(): void {
  process.exit(0);
}

function readStdin(): string {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

// We assume Kimi uses the same tool names as Claude Code.
export function toActions(toolName: string, input: Record<string, unknown>): Action[] {
  switch (toolName) {
    case 'Read':
      return [{ op: 'read', filePath: firstString(input.file_path, input.path) ?? null }];
    case 'Glob':
      return searchActions(input.file_path, input.path, input.pattern);
    case 'Grep':
      return searchActions(input.file_path, input.path, input.glob);
    case 'Write':
      return [
        {
          op: 'write',
          filePath: firstString(input.file_path) ?? null,
          content: firstString(input.content) ?? '',
        },
      ];
    case 'Edit':
      return [
        {
          op: 'write',
          filePath: firstString(input.file_path) ?? null,
          oldString: firstString(input.old_string) ?? '',
          newString: firstString(input.new_string) ?? '',
        },
      ];
    case 'NotebookEdit':
      return [{ op: 'write', filePath: firstString(input.notebook_path) ?? null, content: '' }];
    case 'Bash':
      return [{ op: 'exec', commandString: firstString(input.command) ?? '' }];
    default:
      return unknownToolActions(toolName, input);
  }
}

function main(): void {
  const raw = readStdin();
  let payload: unknown;
  try {
    payload = JSON.parse(raw || '{}');
  } catch {
    fail(
      'guardrails: could not read the hook payload — denying, because an unreadable request is not an approved one',
    );
    return;
  }

  const result = AgentToolHookPayloadSchema.safeParse(payload);
  if (!result.success) {
    fail(
      `guardrails: hook payload does not match the expected shape (${result.error.message}) — denying`,
    );
    return;
  }

  const toolName = result.data.tool_name ?? 'unknown';
  const toolInput = result.data.tool_input ?? {};
  const cwd = result.data.cwd || process.cwd();

  const evalResult = evaluateFromCwd({
    cwd,
    baseActions: toActions(toolName, toolInput),
    // Distinct per subagent, so a coder running inside your own session can be
    // told apart from you and actually caged.
    sessionId: result.data.session_id ?? null,
  });
  // We test for the field, not the boolean. See hook.ts for why.
  if ('reason' in evalResult) {
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
