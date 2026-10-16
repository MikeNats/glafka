// The env the test process gets. GLAFKA_AGENT_CMD is dropped: with it set, the
// "no agent configured" tests find an agent and start a real, paid one.
// The code graph is off: a test must not depend on a tool installed on this machine.
export function testEnv(env = process.env) {
  const { GLAFKA_AGENT_CMD: _dropped, ...rest } = env;
  return { ...rest, GLAFKA_CODE_GRAPH: 'off' };
}
