// How to install superpowers, an optional skills add-on.
// "shell" means we could run it. "chat" means you type it yourself.
export const SUPERPOWERS_INSTALL = Object.freeze({
  // Both of these are marketplace names now, not repo URLs. The URL form was
  // dropped upstream; passing it here fails.
  claude: {
    mechanism: 'chat',
    where: 'in Claude Code',
    command: '/plugin install superpowers@claude-plugins-official',
  },
  cursor: {
    mechanism: 'chat',
    where: "in Cursor's Agent chat",
    command: '/add-plugin superpowers',
  },
  gemini: {
    mechanism: 'shell',
    where: 'in your shell',
    command: 'gemini extensions install https://github.com/obra/superpowers',
  },
  kimi: {
    mechanism: 'chat',
    where: 'in Kimi Code',
    command: '/plugins install https://github.com/obra/superpowers',
  },
  opencode: {
    mechanism: 'chat',
    where: 'tell OpenCode',
    command:
      'Fetch and follow instructions from https://raw.githubusercontent.com/obra/superpowers/refs/heads/main/.opencode/INSTALL.md',
  },
  github: {
    mechanism: 'shell',
    where: 'in your shell',
    command:
      'copilot plugin marketplace add obra/superpowers-marketplace && copilot plugin install superpowers@superpowers-marketplace',
  },
});

// Only lists the tools you really installed. It prints the command instead
// of running it, because it could reach outside the project.
export function superpowersReminder(platforms: string[]): string | null {
  const known = platforms.filter(
    (p): p is keyof typeof SUPERPOWERS_INSTALL => p in SUPERPOWERS_INSTALL,
  );
  if (known.length === 0) return null;

  const width = Math.max(...known.map((p) => p.length));
  const lines = known.map((p) => {
    const { where, command } = SUPERPOWERS_INSTALL[p];
    return `  ${p.padEnd(width)}  ${where}:\n    ${command}`;
  });

  // Same shape as the rest of the install report: heading at the margin,
  // detail indented two.
  return [
    'superpowers — optional, not a dependency',
    '  Every skill doc under docs/glafka/skills/ names which of its skills to',
    '  use at each step. github.com/obra/superpowers',
    '',
    ...lines,
  ].join('\n');
}
