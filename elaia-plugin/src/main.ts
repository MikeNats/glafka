import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { CALLS } from './contract';
import { handlers } from './handlers';

// The glafka plugin as an MCP server: every call Elaia makes is one tool. A tool gets
// { project, args } and answers { result }; a failure is an error result in plain words.
const server = new McpServer({ name: 'glafka', version: '1.0.0' });
const run = handlers(process.env.GLAFKA_BIN || 'glafka');
const input = { project: z.string(), args: z.record(z.string(), z.unknown()).optional() };

for (const call of CALLS) {
  server.registerTool(call, { description: `Elaia: ${call}`, inputSchema: input }, async (req) => {
    try {
      const result = (await run[call](req.project, req.args ?? {})) ?? null;
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        structuredContent: { result },
      };
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: 'text' as const, text }] };
    }
  });
}

// Started by VS Code's own runtime: what glafka starts must not run as that runtime too.
delete process.env.ELECTRON_RUN_AS_NODE;
void server.connect(new StdioServerTransport());
