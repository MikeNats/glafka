import { isClaudePrint } from '../audit/usageFlags.js';
import { loadLevel } from '../../installKit/guardrails/index.js';
import { ROLES } from '../types/ticket.js';

// The standard guardrails level. Its "never" list is the block list every claude agent gets.
const BLOCK_LIST_LEVEL = 2;

// Only the tools a role needs. Every extra tool's docs are start text that each turn re-reads.
const READ_TOOLS = 'Read,Glob,Grep,Bash';
const EDIT_TOOLS = 'Read,Edit,Write,Glob,Grep,Bash';

function toolsFor(role: string): string | null {
  if (role === ROLES.CODER || role === ROLES.REPORTER) return EDIT_TOOLS;
  // A large diff earns reviewer-1, reviewer-2: same job, same tools.
  if (role === ROLES.VERIFIER || role.startsWith(ROLES.REVIEWER)) return READ_TOOLS;
  return null;
}

// "git push" becomes Bash(git push:*), which claude refuses even inside a chain.
function blockList(): string {
  return loadLevel(BLOCK_LIST_LEVEL)
    .exec.never.map((command) => `Bash(${command}:*)`)
    .join(',');
}

function has(agentCmd: string, ...flags: string[]): boolean {
  return flags.some((flag) => new RegExp(`(^|\\s)${flag}(=|\\s|$)`).test(agentCmd));
}

// A claude run starts with only what its role needs: no personal settings, plugins, skills or
// MCP servers, and every shell command except the block list. An option already set is kept.
export function withLeanStart(agentCmd: string, role: string): string {
  if (!isClaudePrint(agentCmd)) return agentCmd;
  const tools = toolsFor(role);
  const flags: string[] = [];
  // Project settings stay: the guardrails hook and the project's CLAUDE.md load from there.
  if (!has(agentCmd, '--setting-sources')) flags.push('--setting-sources project,local');
  if (!has(agentCmd, '--strict-mcp-config', '--mcp-config')) flags.push('--strict-mcp-config');
  if (!has(agentCmd, '--disable-slash-commands')) flags.push('--disable-slash-commands');
  if (tools && !has(agentCmd, '--tools')) flags.push(`--tools ${tools}`);
  // A list someone wrote by hand is their choice. Lists only add up, so the block list always goes on.
  if (tools && !has(agentCmd, '--allowedTools', '--allowed-tools')) {
    flags.push(`--allowedTools ${tools}`);
  }
  flags.push(`--disallowedTools '${blockList()}'`);
  return `${agentCmd} ${flags.join(' ')}`;
}
