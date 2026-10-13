import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CURSOR_NO_WRITE_HOOK } from '../../guardrails/harness.js';

// We commit the plain `glafka` command, never a full install path,
// because a full path would break on any other machine.
export const HOOK_ADAPTER_FILES: Record<string, string> = {
  claude: 'hooks/hook.js',
  gemini: 'hooks/hook-gemini.js',
  cursor: 'hooks/hook-cursor.js',
  copilot: 'hooks/hook-copilot.js',
  opencode: 'hooks/opencode-plugin.js',
};

export interface InstallResult {
  filePath: string;
  already: boolean;
}

interface HookEntry {
  matcher?: string;
  hooks: { type: string; command: string }[];
}

interface HookSettings {
  hooks?: Record<string, HookEntry[]>;
}

// For tools whose hook is one entry added to a named list.
// If our command is already there with a narrower match, we widen it.
function installMatchedHook({
  filePath,
  eventName,
  matcher,
  command,
}: {
  filePath: string;
  eventName: string;
  matcher: string;
  command: string;
}): InstallResult {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const settings: HookSettings = fs.existsSync(filePath)
    ? JSON.parse(fs.readFileSync(filePath, 'utf8'))
    : {};
  settings.hooks ??= {};
  settings.hooks[eventName] ??= [];

  const entry = settings.hooks[eventName].find((e) =>
    (e.hooks ?? []).some((h) => h.command === command),
  );
  if (entry && entry.matcher === matcher) return { filePath, already: true };

  if (entry) {
    entry.matcher = matcher;
  } else {
    settings.hooks[eventName].push({ matcher, hooks: [{ type: 'command', command }] });
  }
  fs.writeFileSync(filePath, `${JSON.stringify(settings, null, 2)}\n`);
  return { filePath, already: false };
}

// Match every tool, not a hand-written list.
// A tool we forgot would run with no check at all.
function installClaudeHook(repoRoot: string): InstallResult {
  return installMatchedHook({
    filePath: path.join(repoRoot, '.claude', 'settings.json'),
    eventName: 'PreToolUse',
    matcher: '*',
    command: 'glafka guardrails --run-hook claude',
  });
}

// Gemini's hook. Same shape as Claude Code's.
// It matches everything, so no tool is missed.
function installGeminiHook(repoRoot: string): InstallResult {
  return installMatchedHook({
    filePath: path.join(repoRoot, '.gemini', 'settings.json'),
    eventName: 'BeforeTool',
    matcher: '*',
    command: 'glafka guardrails --run-hook gemini',
  });
}

interface CopilotHookEntry {
  type?: string;
  command?: string;
  matcher?: string;
  timeoutSec?: number;
}

interface CopilotHookSettings {
  version?: number;
  hooks?: Record<string, CopilotHookEntry[]>;
}

// Copilot reads every .json file in .github/hooks/, so we own one file there and leave any other
// file in that folder alone. No matcher, because an omitted matcher means every tool — a list would
// miss the next new tool. Copilot denies the call on any non-zero exit, so a crash blocks, like
// Claude Code and unlike Cursor.
function installCopilotHook(repoRoot: string): InstallResult {
  const filePath = path.join(repoRoot, '.github', 'hooks', 'glafka-guardrails.json');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const settings: CopilotHookSettings = fs.existsSync(filePath)
    ? JSON.parse(fs.readFileSync(filePath, 'utf8'))
    : { version: 1 };
  settings.version ??= 1;
  settings.hooks ??= {};

  const command = 'glafka guardrails --run-hook copilot';
  settings.hooks.preToolUse ??= [];
  if (settings.hooks.preToolUse.some((h) => h.command === command)) {
    return { filePath, already: true };
  }
  settings.hooks.preToolUse.push({ type: 'command', command });

  fs.writeFileSync(filePath, `${JSON.stringify(settings, null, 2)}\n`);
  return { filePath, already: false };
}

interface CursorHookEntry {
  command: string;
  failClosed?: boolean;
}

interface CursorHookSettings {
  version?: number;
  hooks?: Record<string, CursorHookEntry[]>;
}

// Cursor has three hook events instead of one match rule.
// failClosed:true makes it block when our hook crashes, not allow.
function installCursorHook(repoRoot: string): InstallResult {
  const filePath = path.join(repoRoot, '.cursor', 'hooks.json');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const settings: CursorHookSettings = fs.existsSync(filePath)
    ? JSON.parse(fs.readFileSync(filePath, 'utf8'))
    : { version: 1 };
  settings.hooks ??= {};

  const command = 'glafka guardrails --run-hook cursor';
  let already = true;
  // afterFileEdit is a DETECTOR, not a blocker: Cursor has no before-write hook, so the write has
  // already landed by the time it fires. It is registered so out-of-worktree writes reach the audit log.
  for (const eventName of [
    'beforeShellExecution',
    'beforeReadFile',
    'beforeMCPExecution',
    'afterFileEdit',
  ]) {
    settings.hooks[eventName] ??= [];
    if (settings.hooks[eventName].some((h) => h.command === command)) continue;
    settings.hooks[eventName].push({ command, failClosed: true });
    already = false;
  }
  if (already) return { filePath, already: true };

  fs.writeFileSync(filePath, `${JSON.stringify(settings, null, 2)}\n`);
  return { filePath, already: false };
}

// OpenCode loads plugins from .opencode/plugin/, so we write a small loader
// there. A plain copy would not work, because its own imports would break.
export function installOpenCodeHook(repoRoot: string): InstallResult {
  const filePath = path.join(repoRoot, '.opencode', 'plugin', 'glafka-guardrails.js');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  // No full paths in here. This file is committed, and a path with a home folder in it would tie
  // the ticket to one machine and one user. The first candidate used to be `new
  // URL('../../.glafka/…', import.meta.url)`, which resolves relative to THIS file — and this file
  // lives inside the ticket's worktree, where `.glafka/` does not exist. The worktree is the only
  // place the plugin ever runs, so the cage could never load there. Resolve from
  // the main checkout instead, the same place findRepoRoot uses, and fall back to the installed
  // package.
  const content = [
    '// Generated by `glafka guardrails --install-hook` (see bin/hooks/install.ts).',
    '// Regenerated on every install run — do not hand-edit.',
    '// No full paths on purpose: this file is committed, and its content',
    "// feeds the ticket's saved guardrails fingerprint.",
    "import { execFileSync } from 'node:child_process';",
    "import path from 'node:path';",
    "import { pathToFileURL } from 'node:url';",
    '',
    '// The MAIN checkout, even from inside a worktree: every worktree shares',
    '// one git folder, and its parent is the real root. This is the same rule',
    '// src/util/git.js findRepoRoot uses.',
    'function mainCheckout() {',
    '  try {',
    "    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {",
    "      encoding: 'utf8',",
    '    }).trim();',
    '    return path.dirname(common);',
    '  } catch {',
    '    return null;',
    '  }',
    '}',
    '',
    'async function load() {',
    '  const root = mainCheckout();',
    '  const candidates = [',
    "    root && pathToFileURL(path.join(root, '.glafka', 'installKit', 'guardrails', 'hooks', 'opencode-plugin.js')).href,",
    // The pre-installKit layout, so a project that has not re-run install still loads.
    "    root && pathToFileURL(path.join(root, '.glafka', 'guardrails', 'hooks', 'opencode-plugin.js')).href,",
    "    'glafka/dist/installKit/guardrails/hooks/opencode-plugin.js',",
    '  ].filter(Boolean);',
    '  let lastError;',
    '  for (const specifier of candidates) {',
    '    try {',
    '      return await import(specifier);',
    '    } catch (err) {',
    '      lastError = err;',
    '    }',
    '  }',
    '  throw new Error(',
    "    'glafka guardrails plugin not found — run `glafka install` in this project (' +",
    "      (lastError && lastError.message) + ')',",
    '  );',
    '}',
    '',
    'export const GlafkaGuardrails = async (...args) => (await load()).GlafkaGuardrails(...args);',
    'export default GlafkaGuardrails;',
    '',
  ].join('\n');

  const already = fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8') === content;
  if (already) return { filePath, already: true };

  fs.writeFileSync(filePath, content);
  return { filePath, already: false };
}

// Makes a value safe inside a TOML string.
// Only the backslash and the quote need care.
function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// Kimi's hook config is GLOBAL, so it affects every project on this machine. It runs our hook file directly with node.
const KIMI_MARKER = '# glafka-guardrails — managed by `glafka guardrails --install-hook`';

// Removes only the blocks we own and leaves everyone else's alone.
// A block runs from its own header line to the next header, or the end.
function stripGlafkaKimiBlocks(text: string): string {
  const lines = text.split('\n');
  const kept: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() !== '[[hooks]]') {
      kept.push(lines[i]);
      i += 1;
      continue;
    }
    let end = i + 1;
    while (end < lines.length && !lines[end].trim().startsWith('[')) end += 1;
    const block = lines.slice(i, end);
    const ours =
      block.some((line) => line.includes(KIMI_MARKER)) ||
      block.some((line) => line.includes('guardrails/hook-kimi.js'));
    if (!ours) kept.push(...block);
    else while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();
    i = end;
  }
  return kept.join('\n');
}

function installKimiHook(packageRoot: string): InstallResult {
  const hookPath = path.join(
    packageRoot,
    'dist',
    'installKit',
    'guardrails',
    'hooks',
    'hook-kimi.js',
  );
  // os.homedir() rather than $HOME: Windows sets USERPROFILE, so $HOME is
  // empty there and this would write to the drive root.
  const filePath = path.join(os.homedir(), '.kimi-code', 'config.toml');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  const command = `node ${JSON.stringify(hookPath)}`;

  // Matches everything, like the other installers, so no tool is missed.
  const block =
    `[[hooks]]\n${KIMI_MARKER}\nevent = "PreToolUse"\n` +
    `matcher = ${tomlString('*')}\ncommand = ${tomlString(command)}\n`;

  // Always rewrite our block instead of checking then adding. The old check never matched, so every run added one more copy.
  const kept = stripGlafkaKimiBlocks(existing).replace(/\n+$/, '');
  const next = kept.length > 0 ? `${kept}\n\n${block}` : block;
  if (next === existing) return { filePath, already: true };

  fs.writeFileSync(filePath, next);
  return { filePath, already: false };
}

export interface InstallerOutcome {
  name: string;
  scope: string;
  filePath: string | null;
  already: boolean;
  error: string | null;
  // What this harness CANNOT enforce, even with the hook installed. Printed on every install run,
  // because a cage with a missing side has to say so at the moment you are told it is on.
  caveat: string | null;
}

// What each project-scope installer above leaves behind. Kimi is left out on purpose: its config is
// global, so finding it proves nothing about THIS project. Keep in step with the installers.
const PROJECT_HOOK_MARKERS: { name: string; file: string[]; contains: string | null }[] = [
  { name: 'Claude Code', file: ['.claude', 'settings.json'], contains: '--run-hook claude' },
  { name: 'Gemini CLI', file: ['.gemini', 'settings.json'], contains: '--run-hook gemini' },
  { name: 'Cursor', file: ['.cursor', 'hooks.json'], contains: '--run-hook cursor' },
  {
    name: 'GitHub Copilot CLI',
    file: ['.github', 'hooks', 'glafka-guardrails.json'],
    contains: '--run-hook copilot',
  },
  // A file we own outright, so its existence is the whole answer.
  { name: 'OpenCode', file: ['.opencode', 'plugin', 'glafka-guardrails.js'], contains: null },
];

// Which harnesses already have the hook wired here. Read-only, so it can run on any command
// that only wants to WARN about the state, never to change it.
export function installedProjectHooks(repoRoot: string): string[] {
  return PROJECT_HOOK_MARKERS.filter(({ file, contains }) => {
    const filePath = path.join(repoRoot, ...file);
    if (!fs.existsSync(filePath)) return false;
    if (contains === null) return true;
    try {
      return fs.readFileSync(filePath, 'utf8').includes(contains);
    } catch {
      // Unreadable is not installed. Guessing the other way would silence
      // the warning that this exists to raise.
      return false;
    }
  }).map(({ name }) => name);
}

// Runs every installer. One failing, for example on a read-only file,
// must not stop the rest.
export function installAllHooks(repoRoot: string, packageRoot: string): InstallerOutcome[] {
  const installers: {
    name: string;
    scope: string;
    caveat?: string;
    run: () => InstallResult;
  }[] = [
    { name: 'Claude Code', scope: 'project', run: () => installClaudeHook(repoRoot) },
    { name: 'Gemini CLI', scope: 'project', run: () => installGeminiHook(repoRoot) },
    {
      name: 'Cursor',
      scope: 'project',
      caveat: CURSOR_NO_WRITE_HOOK,
      run: () => installCursorHook(repoRoot),
    },
    { name: 'GitHub Copilot CLI', scope: 'project', run: () => installCopilotHook(repoRoot) },
    { name: 'OpenCode', scope: 'project', run: () => installOpenCodeHook(repoRoot) },
    {
      name: 'Kimi Code CLI',
      scope: 'global — affects every project on this machine',
      run: () => installKimiHook(packageRoot),
    },
  ];

  return installers.map(({ name, scope, caveat, run }) => {
    try {
      const { filePath, already } = run();
      return { name, scope, filePath, already, error: null, caveat: caveat ?? null };
    } catch (err) {
      return {
        name,
        scope,
        filePath: null,
        already: false,
        error: (err as Error).message,
        caveat: caveat ?? null,
      };
    }
  });
}
