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

// Gemini's hook, run before each tool. The real logic lives in core.js.
// This file only renames Gemini's tools and fields to ours.

function fail(reason: string): void {
  process.stdout.write(`${JSON.stringify({ decision: 'deny', reason })}\n`);
  process.stderr.write(`${reason}\n`);
  process.exit(2);
}

function pass(): void {
  process.stdout.write(`${JSON.stringify({ decision: 'allow' })}\n`);
  process.exit(0);
}

function readStdin(): string {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

// Turns a Gemini tool name into our own action shape.
export function toActions(toolName: string, input: Record<string, unknown>): Action[] {
  switch (toolName) {
    case 'read_file':
      return [
        {
          op: 'read',
          filePath: firstString(input.absolute_path, input.file_path, input.path) ?? null,
        },
      ];
    case 'list_directory':
      return searchActions(input.path, input.absolute_path);
    case 'glob':
      return searchActions(input.path, input.absolute_path, input.pattern);
    case 'search_file_content':
      // Here `pattern` is the search text, and `include` picks the files.
      return searchActions(input.path, input.absolute_path, input.include);
    case 'write_file':
      return [
        {
          op: 'write',
          filePath: firstString(input.file_path, input.absolute_path) ?? null,
          content: firstString(input.content) ?? '',
        },
      ];
    case 'replace':
      return [
        {
          op: 'write',
          filePath: firstString(input.file_path, input.absolute_path) ?? null,
          oldString: firstString(input.old_string) ?? '',
          newString: firstString(input.new_string) ?? '',
        },
      ];
    case 'run_shell_command':
      return [{ op: 'exec', commandString: firstString(input.command) ?? '' }];
    default:
      // Anything else is checked by what it carries, not by its name.
      return unknownToolActions(toolName, input);
  }
}

export function main(): void {
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

// Run main() only when this file is run directly. The try/catch matters:
// without it, an error here would crash instead of refusing.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch (err) {
    fail(`guardrails: internal error (${(err as Error).message}) — denying`);
  }
}
