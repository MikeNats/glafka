import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scan, DEFAULT_PATTERNS } from '../../installKit/guardrails/layers/hostexec.js';
import { HOOK_CONFIG_PATHS } from '../../installKit/guardrails/pin.js';

// This checks that hostexec finds files that will run on your real machine,
// not in a safe sandbox.

// glafka runs every command in .glafka.json using `sh -c`, on your real machine.
test('.glafka.json and isolation.json are flagged', () => {
  const flagged = scan(['.glafka.json', 'docs/glafka/architecture/isolation.json', 'src/a.ts']);
  assert.deepEqual(flagged, ['.glafka.json', 'docs/glafka/architecture/isolation.json']);
});

// .claude/settings.json can run shell commands on your machine later.
// .mcp.json starts servers on your machine too. Both must be flagged.
test('every harness config pin.ts hashes is also flagged at review', () => {
  const missed = HOOK_CONFIG_PATHS.filter((p) => scan([p]).length === 0);
  assert.deepEqual(missed, [], 'pin.ts and hostexec must not disagree about what matters');
});

test('container and build-system files that run on the host are flagged', () => {
  const changed = [
    '.mcp.json',
    'Dockerfile',
    'docker-compose.yml',
    'pyproject.toml',
    'build.rs',
    'scripts/deploy.bash',
    '.tool-versions',
  ];
  assert.deepEqual(scan(changed), changed);
});

// Maven plugin goals, gradle build scripts and sbt project files all execute
// during a plain build, before any test or main method runs.
test('jvm build files are flagged', () => {
  const changed = [
    'pom.xml',
    'svc/pom.xml',
    'mvnw',
    '.mvn/wrapper/maven-wrapper.properties',
    'build.gradle',
    'build.gradle.kts',
    'app/settings.gradle.kts',
    'gradle.properties',
    'gradlew',
    'gradle/wrapper/gradle-wrapper.properties',
    'build.sbt',
    'project/plugins.sbt',
    'project/Build.scala',
    'project/build.properties',
    '.sbtopts',
    '.jvmopts',
  ];
  assert.deepEqual(scan(changed), changed);
});

// MSBuild runs <Exec> tasks and custom targets during `dotnet build`.
test('.NET project and MSBuild files are flagged', () => {
  const changed = [
    'Api.csproj',
    'src/Api.csproj',
    'Lib.fsproj',
    'Directory.Build.props',
    'Directory.Build.targets',
    'nuget.config',
    'global.json',
  ];
  assert.deepEqual(scan(changed), changed);
});

test('windows shells and package-manager configs are flagged', () => {
  const changed = ['scripts/x.ps1', 'x.bat', 'x.cmd', 'x.zsh', '.yarnrc.yml', 'bunfig.toml'];
  assert.deepEqual(scan(changed), changed);
});

test('python startup and test-runner hooks are flagged', () => {
  const changed = ['pkg/setup.py', 'noxfile.py', 'tox.ini', 'sitecustomize.py', 'usercustomize.py'];
  assert.deepEqual(scan(changed), changed);
});

test('ordinary source files are still not flagged', () => {
  assert.deepEqual(scan(['src/a.ts', 'README.md', 'test/b.test.ts']), []);
});

// The new stack patterns must not swallow plain source files, and a folder
// called "project" in a non-sbt repo is not an sbt build.
test('source files of the new stacks are not flagged', () => {
  const quiet = [
    'src/main/java/App.java',
    'Main.scala',
    'Program.cs',
    'apps/project/src/x.ts',
    'model.pth',
    'pkg/mod.py',
  ];
  assert.deepEqual(scan(quiet), []);
});

test('the pattern list has no duplicates', () => {
  assert.equal(new Set(DEFAULT_PATTERNS).size, DEFAULT_PATTERNS.length);
});
