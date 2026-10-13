// Writes the real ports plainly, with no vague wording. The coder and the QA tester
// prompts both name them.
export function portsLine({
  port,
  isolationPorts,
}: {
  port: number | null;
  isolationPorts: Record<string, number> | null;
}): string | null {
  if (isolationPorts && Object.keys(isolationPorts).length > 0) {
    return Object.entries(isolationPorts)
      .map(([name, value]) => `${name}=${value}`)
      .join(' · ');
  }
  return port == null ? null : `PORT=${port}`;
}
