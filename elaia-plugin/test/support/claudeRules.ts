// A small copy of how Claude Code matches Bash permission rules, taken from its permissions
// docs (code.claude.com/docs/en/permissions). Tests use it to show which commands Elaia's rules
// stop. Test commands keep && ; | & out of their quotes: this split does not read quotes.

const escape = (text: string) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

// One rule as a regular expression, or null for a rule that is not about Bash. `X:*` is `X *`,
// `*` is any text, and a trailing ` *` that is the rule's only `*` also matches the bare command.
function patternOf(rule: string): RegExp | null {
  if (rule === 'Bash') return /^/;
  const inner = /^Bash\((.*)\)$/s.exec(rule)?.[1];
  if (inner === undefined) return null;
  const text = inner.endsWith(':*') ? `${inner.slice(0, -2)} *` : inner;
  const pieces = text.split('*');
  if (pieces.length === 2 && text.endsWith(' *')) {
    return new RegExp(`^${escape(text.slice(0, -2))}( .*)?$`, 's');
  }
  return new RegExp(`^${pieces.map(escape).join('.*')}$`, 's');
}

// The commands Claude checks one by one: a chain split at && || |& ; | & and new lines, each
// past any leading VAR=value (a deny rule matches past every assignment).
export function commandsOf(command: string): string[] {
  return command
    .split(/&&|\|\||\|&|;|\||&|\n/)
    .map((part) => part.trim().replace(/^(?:[A-Za-z_]\w*=\S*\s+)+/, ''))
    .filter((part) => part !== '');
}

// True when one of these deny rules stops the command.
export function blockedBy(rules: string[], command: string): boolean {
  const patterns = rules.map(patternOf).filter((p): p is RegExp => p !== null);
  return commandsOf(command).some((part) => patterns.some((p) => p.test(part)));
}
