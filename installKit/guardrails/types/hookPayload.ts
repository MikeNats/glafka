import { z } from 'zod';
import type { Action } from './action.js';

// The message Claude Code, Gemini and Kimi all send us. It comes from outside, so we check its shape before reading any field.
export const AgentToolHookPayloadSchema = z.object({
  tool_name: z.string().optional(),
  tool_input: z.record(z.string(), z.unknown()).optional(),
  cwd: z.string().optional(),
  // Distinct per subagent, which is what lets a coder running inside your own session be told apart
  // from you. Optional: a harness that does not send one simply gets today's behaviour.
  session_id: z.string().optional(),
  // Where the harness keeps this session's transcript. Optional, like session_id:
  // a harness that does not send one gets exactly today's behaviour.
  transcript_path: z.string().optional(),
});
export type AgentToolHookPayload = z.infer<typeof AgentToolHookPayloadSchema>;

// Returns the first value that really is text.
// We check the type instead of casting, because these values are unknown.
export function firstString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === 'string') return v;
  }
  return undefined;
}

// One read action per path a search tool carries. A file pattern is a path too, so we must not ignore it.
export function searchActions(...candidates: unknown[]): Action[] {
  const paths = candidates.filter((v): v is string => typeof v === 'string' && v !== '');
  if (paths.length === 0) return [{ op: 'read', filePath: '.' }];
  return paths.map((filePath) => ({ op: 'read' as const, filePath }));
}

// Field names that hold a file path, across every tool we know of.
// The list is wide on purpose: a wrong guess costs one extra check.
const PATH_FIELDS = [
  'file_path',
  'filePath',
  'path',
  'absolute_path',
  'notebook_path',
  'target_file',
  'directory',
  'dir',
];

const COMMAND_FIELDS = ['command', 'cmd', 'script', 'shell_command'];

// A tool we do not know yet. If it carries a path or a command, we check it as one, and we treat an unknown path as a WRITE, which is the safer read.
export function unknownToolActions(toolName: string, input: Record<string, unknown>): Action[] {
  const actions: Action[] = [];
  for (const field of COMMAND_FIELDS) {
    const value = input[field];
    if (typeof value === 'string' && value !== '') {
      actions.push({ op: 'exec', commandString: value });
    }
  }
  for (const field of PATH_FIELDS) {
    const value = input[field];
    if (typeof value === 'string' && value !== '') {
      actions.push({ op: 'write', filePath: value, content: '' });
    }
  }
  actions.push({ op: String(toolName) });
  return actions;
}
