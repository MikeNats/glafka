#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { evaluateFromCwd, findRepoRoot } from '../core.js';
import { sessionSizeWarning } from '../sessionSize.js';
import {
  AgentToolHookPayloadSchema,
  firstString,
  searchActions,
  unknownToolActions,
} from '../types/hookPayload.js';
import type { Action } from '../types/action.js';

// Claude Code's hook, run before each tool. The real logic lives in core.js.
// If anything goes wrong we must refuse, since silence would mean allow.

function fail(reason: string): void {
  process.stdout.write(`${JSON.stringify({ decision: 'block', reason })}\n`);
  process.stderr.write(`${reason}\n`);
  process.exit(2);
}

// systemMessage is what reaches the person. Plain stdout on a pass does not.
function pass(systemMessage?: string | null): void {
  if (systemMessage) process.stdout.write(`${JSON.stringify({ systemMessage })}\n`);
  process.exit(0);
}

// The warning is not a guardrail, so it must work even at level 0, where
// evaluateFromCwd returns before it ever reaches the state directory.
function stateDirOf(cwd: string): string | null {
  try {
    return path.join(findRepoRoot(cwd), '.glafka');
  } catch {
    return null;
  }
}

function readStdin(): string {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

// Tools that touch nothing outside the editor's own notes. We name them here, because refusing them
// does not make the coder safer, only blind. Task and SlashCommand only start work; the tools they
// then call come back through this same hook one by one, so checking the starter twice adds
// nothing.
const INERT_TOOLS = new Set([
  'TodoWrite',
  'BashOutput',
  'KillShell',
  'ExitPlanMode',
  'Skill',
  'ToolSearch',
  'Task',
  'SlashCommand',
]);

// Tools that reach out. They are network actions, not unknown ones.
const FETCH_TOOLS = new Set(['WebFetch', 'WebSearch']);

// Turns a tool call into the shape our layers understand.
export function toActions(toolName: string, input: Record<string, unknown>): Action[] {
  if (INERT_TOOLS.has(toolName)) return [{ op: 'noop', tool: toolName }];
  if (FETCH_TOOLS.has(toolName)) {
    return [{ op: 'fetch', url: firstString(input.url, input.query) ?? null }];
  }
  switch (toolName) {
    case 'Read':
      return [{ op: 'read', filePath: firstString(input.file_path, input.path) ?? null }];
    case 'Glob':
      // For Glob, the pattern IS the target.
      return searchActions(input.file_path, input.path, input.pattern);
    case 'Grep':
      // For Grep, `pattern` is the search text. `glob` picks the files.
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
  // We test for the field, not the boolean, because type narrowing on a
  // boolean is not reliable with this tsconfig.
  if ('reason' in evalResult) {
    fail(`guardrails [${evalResult.layer ?? 'policy'}]: ${evalResult.reason}`);
    return;
  }
  // Only on the way through. A blocked call already has the person's attention.
  const stateDir = stateDirOf(cwd);
  pass(
    stateDir === null
      ? null
      : sessionSizeWarning({
          stateDir,
          sessionId: result.data.session_id ?? null,
          transcriptPath: result.data.transcript_path ?? null,
        }),
  );
}

// Run main() only when this file is run directly, not when imported.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch (err) {
    fail(`guardrails: internal error (${(err as Error).message}) — denying`);
  }
}
