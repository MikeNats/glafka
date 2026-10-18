import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { inject } from 'vitest';

// The plugin as Elaia talks to it: an MCP server over stdio, running the glafka at `bin`.
export async function connect(bin: string, env: Record<string, string> = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [inject('plugin')],
    env: { ...(process.env as Record<string, string>), GLAFKA_BIN: bin, ...env },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(transport);
  // One tool call, as Elaia makes it: { project, args } in, { result } out.
  const call = async (tool: string, project: string, args: object = {}) => {
    const res = (await client.callTool({ name: tool, arguments: { project, args } })) as {
      isError?: boolean;
      structuredContent?: { result: unknown };
      content: { text: string }[];
    };
    if (res.isError) throw new Error(res.content[0]?.text);
    return res.structuredContent?.result;
  };
  return { client, call };
}
