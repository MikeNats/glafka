import { globToRegExp } from './filesystem.js';
import { HOOK_CONFIG_PATHS } from '../pin.js';
import type { Policy } from '../types/policy.js';
import type { LayerMeta } from '../types/layer.js';

// The cage can not stop this: the agent edits a file that YOU run later.
// We do not block those edits. We point them out at review and push time.

export const meta: LayerMeta = {
  name: 'hostexec',
  kind: 'spotlight',
  rung: 5,
  what: 'names the changed files that will execute on YOUR machine, not in the cage',
  beatenBy: 'not reading the list',
};

// Files that run on your machine without you deciding to run them as code.
export const DEFAULT_PATTERNS: readonly string[] = Object.freeze([
  // package manager lifecycle
  'package.json',
  '**/package.json',
  '.npmrc',
  '**/.npmrc',
  'pnpm-workspace.yaml',
  // build runners
  'Makefile',
  '**/Makefile',
  'justfile',
  'Taskfile.yml',
  // git-driven execution
  '.git/hooks/**',
  '.husky/**',
  '.pre-commit-config.yaml',
  // editor and CI runners
  '.vscode/tasks.json',
  '.vscode/launch.json',
  '.github/workflows/**',
  '.gitlab-ci.yml',
  // shell scripts
  '.envrc',
  '*.sh',
  '**/*.sh',
  '*.zsh',
  '**/*.zsh',
  // windows shells, which run the same way on a windows host
  '*.ps1',
  '**/*.ps1',
  '*.bat',
  '**/*.bat',
  '*.cmd',
  '**/*.cmd',
  // python packaging hooks
  'setup.py',
  '**/setup.py',
  'conftest.py',
  '**/conftest.py',
  // python test runners that import and execute project code
  'noxfile.py',
  '**/noxfile.py',
  'tox.ini',
  '**/tox.ini',
  // python startup hook: imported by the interpreter itself, before your code
  'sitecustomize.py',
  '**/sitecustomize.py',
  'usercustomize.py',
  '**/usercustomize.py',
  // Our own config. The commands in here run on YOUR machine,
  // outside every cage.
  '.glafka.json',
  'docs/glafka/architecture/isolation.json',
  // Tool configs, taken from pin.ts's own list so the two never disagree.
  // A change in one of these turns the cage off.
  ...HOOK_CONFIG_PATHS,
  // Plus the rest of each tool's folder, which the list above misses.
  '.claude/**',
  '.cursor/**',
  '.gemini/**',
  '.opencode/**',
  '.kimi/**',
  '.kimi-code/**',
  '.mcp.json',
  // container and toolchain files, which all run on your machine
  'Dockerfile',
  '**/Dockerfile',
  'docker-compose*.yml',
  'docker-compose*.yaml',
  '.tool-versions',
  // build systems with an execute-on-build step
  'pyproject.toml',
  '**/pyproject.toml',
  'build.rs',
  '**/build.rs',
  '*.bash',
  '**/*.bash',
  // node package managers whose config can load plugins on install
  '.yarnrc.yml',
  '**/.yarnrc.yml',
  'bunfig.toml',
  '**/bunfig.toml',
  // maven: plugin goals bind to build phases and run on your machine
  'pom.xml',
  '**/pom.xml',
  'mvnw',
  'mvnw.cmd',
  '.mvn/**',
  // gradle: the build script IS Groovy or Kotlin, executed at configure time
  'build.gradle',
  '**/build.gradle',
  'build.gradle.kts',
  '**/build.gradle.kts',
  'settings.gradle',
  '**/settings.gradle',
  'settings.gradle.kts',
  '**/settings.gradle.kts',
  'gradle.properties',
  '**/gradle.properties',
  'gradlew',
  'gradlew.bat',
  // the wrapper's distributionUrl decides which gradle binary gets downloaded
  // and run, so a change here can swap the whole toolchain.
  'gradle/**',
  // sbt: every .sbt file and everything under project/ is Scala that sbt
  // compiles and runs while it loads the build, before any task starts.
  '*.sbt',
  '**/*.sbt',
  // Narrow, not `project/**`: plenty of repos have a folder called project
  // that has nothing to do with sbt.
  'project/*.scala',
  '**/project/*.scala',
  'project/*.properties',
  '**/project/*.properties',
  '.sbtopts',
  '.jvmopts',
  // .NET / MSBuild: <Exec> and custom targets run during a plain `dotnet build`
  '*.csproj',
  '**/*.csproj',
  '*.fsproj',
  '**/*.fsproj',
  '*.vbproj',
  '**/*.vbproj',
  '*.props',
  '**/*.props',
  '*.targets',
  '**/*.targets',
  'nuget.config',
  '**/nuget.config',
  'global.json',
  '**/global.json',
]);

// Keeps only the changed files that can run on your machine.
export function scan(changedPaths: string[], extraPatterns: string[] = []): string[] {
  const patterns = [...DEFAULT_PATTERNS, ...extraPatterns];
  const regexes = patterns.map((p) => globToRegExp(p));
  return changedPaths.filter((p) => regexes.some((re) => re.test(p)));
}

// The same scan, but answering to the layer's own switch. `scan` is the raw pattern match and has no
// opinion; every caller that BLOCKS on the result has to go through here instead.
//
// The three callers that block — `checks`, `ergon --review`, `ergon --status` — used to call `scan`
// directly, so the layer fired even at level 0, whose policy sets `flagHostExecutingChanges: false`
// and whose own `describe()` promises "changes that run on your machine are not called out". Level 0
// is also the DEFAULT. The result was a checks gate nothing could move: the message says "read those
// files, then re-run", but nothing records that you read them, so the re-run says the same thing for
// ever and `epistle` refuses on checks that can never run. Blocking is right at a level that asked
// for a cage; at a level that asked for none it is a dead end.
export function blockingScan(policy: Policy, changedPaths: string[]): string[] {
  if (!policy.hostexec.flagHostExecutingChanges) return [];
  return scan(changedPaths, policy.hostexec.hostExecutingPatterns ?? []);
}

// Shown at review and at push. Null when there is nothing to say.
export function warning(policy: Policy, changedPaths: string[]): string | null {
  if (!policy.hostexec.flagHostExecutingChanges) return null;

  const hits = scan(changedPaths, policy.hostexec.hostExecutingPatterns ?? []);
  if (hits.length === 0) return null;

  return [
    `${hits.length} changed file(s) RUN ON YOUR MACHINE, outside the cage:`,
    ...hits.map((p) => `    ${p}`),
    '  The agent could not run these itself. You will, the next time you build,',
    '  test, commit or install. Read them before you do.',
  ].join('\n');
}

export function describe(policy: Policy): string[] {
  if (!policy.hostexec.flagHostExecutingChanges) {
    return ['off — changes that run on your machine are not called out'];
  }
  const extra = policy.hostexec.hostExecutingPatterns ?? [];
  return [
    `${DEFAULT_PATTERNS.length + extra.length} pattern(s) watched`,
    '  shown at review and at push — not blocked, because adding a script is normal work',
  ];
}
