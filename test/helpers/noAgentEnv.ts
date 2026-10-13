import { after } from 'node:test';

// With GLAFKA_AGENT_CMD set, a "no agent configured" test finds an agent and starts a real,
// paid one. Call it at the top of such a test file: cleared now, put back after the file.
export function withoutAgentCmd(): () => void {
  const saved = process.env.GLAFKA_AGENT_CMD;
  delete process.env.GLAFKA_AGENT_CMD;
  const restore = (): void => {
    if (saved === undefined) delete process.env.GLAFKA_AGENT_CMD;
    else process.env.GLAFKA_AGENT_CMD = saved;
  };
  after(restore);
  return restore;
}
