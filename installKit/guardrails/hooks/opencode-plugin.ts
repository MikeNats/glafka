import { z } from 'zod';

import { evaluateFromCwd } from '../core.js';
import { firstString, searchActions, unknownToolActions } from '../types/hookPayload.js';
import type { Action } from '../types/action.js';

// OpenCode's plugin hook. Same logic as the other hooks, see core.js.
// It runs inside the same process, so a refusal is a thrown error.

// OpenCode hands us real objects, not text. It is still input from outside,
// so we still check its shape.
const ToolExecuteInputSchema = z.object({
  tool: z.string(),
});
const ToolExecuteOutputSchema = z.object({
  args: z.record(z.string(), z.unknown()).optional(),
});

export function toActions(toolName: string, args: Record<string, unknown>): Action[] {
  switch (toolName) {
    case 'read':
      return [{ op: 'read', filePath: firstString(args.filePath, args.path) ?? null }];
    case 'glob':
      return searchActions(args.filePath, args.path, args.pattern);
    case 'grep':
      return searchActions(args.filePath, args.path, args.include);
    case 'write':
      return [
        {
          op: 'write',
          filePath: firstString(args.filePath) ?? null,
          content: firstString(args.content) ?? '',
        },
      ];
    case 'edit':
    case 'patch':
      return [
        {
          op: 'write',
          filePath: firstString(args.filePath) ?? null,
          oldString: firstString(args.oldString) ?? '',
          newString: firstString(args.newString) ?? '',
        },
      ];
    case 'bash':
      return [{ op: 'exec', commandString: firstString(args.command) ?? '' }];
    default:
      return unknownToolActions(toolName, args);
  }
}

export const GlafkaGuardrails = async () => ({
  'tool.execute.before': async (input: unknown, output: unknown) => {
    const parsedInput = ToolExecuteInputSchema.safeParse(input);
    if (!parsedInput.success) {
      throw new Error(
        `guardrails: could not read the OpenCode tool payload (${parsedInput.error.message}) — denying`,
      );
    }
    const parsedOutput = ToolExecuteOutputSchema.safeParse(output ?? {});
    if (!parsedOutput.success) {
      throw new Error(
        `guardrails: could not read the OpenCode tool payload (${parsedOutput.error.message}) — denying`,
      );
    }

    const cwd = process.cwd();
    const result = evaluateFromCwd({
      cwd,
      baseActions: toActions(parsedInput.data.tool, parsedOutput.data.args ?? {}),
    });
    // We test for the field, not the boolean. See hook.ts for why.
    if ('reason' in result) {
      throw new Error(`guardrails [${result.layer ?? 'policy'}]: ${result.reason}`);
    }
  },
});

export default GlafkaGuardrails;
