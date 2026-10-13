#!/usr/bin/env node
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

import { evaluateFromCwd } from '../core.js';
import { firstString, searchActions, unknownToolActions } from '../types/hookPayload.js';
import type { Action } from '../types/action.js';

// GitHub Copilot CLI's preToolUse hook. The real logic lives in core.js. Copilot FAILS CLOSED: any
// non-zero exit denies the tool call, and exit 2 denies even if our JSON said allow. So a crash here blocks, like Claude Code.

// Copilot sends one of two shapes for the same event, so we accept both.
// Its own camelCase form, and a VS Code compatible snake_case form.
const CopilotHookPayloadSchema = z.object({
  toolName: z.string().optional(),
  toolArgs: z.unknown().optional(),
  tool_name: z.string().optional(),
  tool_input: z.unknown().optional(),
  cwd: z.string().optional(),
});
type CopilotHookPayload = z.infer<typeof CopilotHookPayloadSchema>;

function fail(reason: string): void {
  process.stdout.write(
    `${JSON.stringify({ permissionDecision: 'deny', permissionDecisionReason: reason })}\n`,
  );
  process.stderr.write(`${reason}\n`);
  process.exit(2);
}

function pass(): void {
  process.stdout.write(`${JSON.stringify({ permissionDecision: 'allow' })}\n`);
  process.exit(0);
}

function readStdin(): string {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

// Copilot may send the tool arguments as an object, or as a JSON string holding that object. Anything
// we cannot read becomes an empty record, and the tool is then checked by name alone rather than waved through.
export function readToolArgs(raw: unknown): Record<string, unknown> {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

// Copilot's tool names are its own, and it adds new ones over time. The names we know are mapped
// here; everything else falls through to the shared unknown-tool path, which reads any path or command field it can find and treats an unknown path as a write.
export function toActions(toolName: string, input: Record<string, unknown>): Action[] {
  switch (toolName) {
    case 'bash':
    case 'shell':
      return [
        {
          op: 'exec',
          commandString: firstString(input.command, input.cmd, input.script) ?? '',
        },
      ];
    case 'view':
    case 'read':
    case 'read_file':
      return [{ op: 'read', filePath: firstString(input.path, input.file_path) ?? null }];
    case 'glob':
    case 'grep':
    case 'search':
      return searchActions(input.path, input.file_path, input.pattern, input.glob);
    case 'edit':
    case 'str_replace':
      return [
        {
          op: 'write',
          filePath: firstString(input.path, input.file_path) ?? null,
          oldString: firstString(input.old_str, input.old_string) ?? '',
          newString: firstString(input.new_str, input.new_string) ?? '',
        },
      ];
    case 'create':
    case 'write':
    case 'write_file':
      return [
        {
          op: 'write',
          filePath: firstString(input.path, input.file_path) ?? null,
          content: firstString(input.content, input.file_text) ?? '',
        },
      ];
    // A delete is a write to us: it changes the file, so the same paths are
    // out of bounds.
    case 'delete_file':
      return [
        {
          op: 'write',
          filePath: firstString(input.path, input.file_path) ?? null,
          content: '',
        },
      ];
    default:
      return unknownToolActions(toolName, input);
  }
}

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

  const result = CopilotHookPayloadSchema.safeParse(parsed);
  if (!result.success) {
    fail(
      `guardrails: hook payload does not match the expected shape (${result.error.message}) — denying`,
    );
    return;
  }
  const payload: CopilotHookPayload = result.data;

  const toolName = payload.toolName ?? payload.tool_name ?? 'unknown';
  const toolInput = readToolArgs(payload.toolArgs ?? payload.tool_input);
  const cwd = payload.cwd || process.cwd();

  const evalResult = evaluateFromCwd({ cwd, baseActions: toActions(toolName, toolInput) });
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
