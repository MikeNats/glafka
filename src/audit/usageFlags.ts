import { agentName } from './parseUsage.js';

// Claude only reports its token counts when it is asked for machine output.
// Every other agent is left exactly as you wrote it.
const CLAUDE = 'claude';

// stream-json, not json: json prints nothing until the run ends, so the log
// stops growing and every live run reads as stalled. --verbose is required.
const USAGE_FLAGS = '--output-format stream-json --verbose';

// Punctuation that makes a string more than one command — a pipe, a chain, a
// redirect. Flags added at the end would land on the wrong one.
const SHELL_OPERATORS = '|&;<>()`$';

// Print mode is what stream-json needs. Without it the flags are an error.
const PRINT_FLAG = /(^|\s)(-p|--print)(\s|$)/;

// Only punctuation the shell would ACT on counts. Inside quotes it is plain
// text, and a real --allowedTools list is full of it: Bash(git log:*).
function hasShellOperator(command: string): boolean {
  let quote: string | null = null;
  for (const character of command) {
    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (SHELL_OPERATORS.includes(character)) return true;
  }
  return false;
}

// One plain `claude -p` command, safe to add flags to. Anything else is left as written.
export function isClaudePrint(agentCmd: string): boolean {
  if (hasShellOperator(agentCmd)) return false;
  return agentName(agentCmd) === CLAUDE && PRINT_FLAG.test(agentCmd);
}

// Adds what a background run needs to report its token usage, when it is safe
// to add. Anything unrecognised comes back untouched.
export function withUsageFlags(agentCmd: string): string {
  if (!isClaudePrint(agentCmd)) return agentCmd;
  // Already asked for an output format of its own. That choice wins.
  if (agentCmd.includes('--output-format')) return agentCmd;
  return `${agentCmd} ${USAGE_FLAGS}`;
}
