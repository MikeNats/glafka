import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findRepoRoot } from '../core.js';
import type { Policy } from '../types/policy.js';
import type { LayerMeta } from '../types/layer.js';
import { wrap } from './sandbox/wrap.js';
import { DEFAULT_IMAGE, detect, pickBackend } from './sandbox/detect.js';
import { ownBranchRef } from './sandbox/gitPaths.js';
import { seatbeltProfile } from './sandbox/seatbelt.js';

export { wrap, detect, pickBackend, seatbeltProfile, ownBranchRef };

// A secret goes to docker by NAME only, so its value stays off the command
// line, where `ps` and `docker inspect` would show it. See isSecretName.

// LAYER: sandbox — the WALL. The operating system blocks disk and network
// for every child process, so nothing running inside can trick it.

export const meta: LayerMeta = {
  name: 'sandbox',
  kind: 'wall',
  rung: 1,
  what: 'the operating system refuses the disk and the network, for every child process',
  // Honest about the doors still open. The shared git folder is now narrowed to what committing
  // measurably needs — this branch's own ref and reflog — so other branches, HEAD, index, logs/ and
  // packed-refs are shut. What stays open: the object store is shared by design,
  // and a detached HEAD has no ref to give back so nothing is narrowed there.
  beatenBy:
    'git objects are shared and writable, so a coder can add to your object store; ' +
    'on a detached HEAD the whole shared .git stays writable',
};

// --------------------------------------------------------------------------- selfTest: proof, not promises

// Docker pulls a missing image on first use. That takes minutes and looks
// like a broken sandbox, so check up front and say it plainly.
function imageReady(policy: Pick<Policy, 'sandbox'>): { ok: boolean; image: string } {
  const image = policy.sandbox.image ?? DEFAULT_IMAGE;
  const r = spawnSync('docker', ['image', 'inspect', image], { stdio: 'ignore' });
  return r.status === 0 ? { ok: true, image } : { ok: false, image };
}

// A rough guess only: `agentCmd` is any shell string, so we read its first
// word. A wrong guess skips a test, which is safer than a false pass.
function agentBinary(agentCmd: string | null | undefined): string | null {
  const first = agentCmd?.trim().split(/\s+/)[0];
  return first || null;
}

export interface SelfTestResult {
  label: string;
  pass: boolean | null;
  detail: string;
  backend: string;
}

type RunResult =
  | { started: false; note: string; backend: string }
  | { started: true; ok: boolean; output: string; backend: string };

export function selfTest(
  policy: Pick<Policy, 'sandbox'>,
  {
    worktree,
    scratch,
    stateDir,
    agentCmd = null,
  }: { worktree: string; scratch: string; stateDir: string; agentCmd?: string | null },
): SelfTestResult[] {
  const results: SelfTestResult[] = [];
  const backend = pickBackend(policy);

  if (backend.name === 'docker') {
    const img = imageReady(policy);
    if (!img.ok) {
      return [
        {
          label: 'docker image present',
          pass: false,
          detail: `${img.image} is not pulled yet — run: docker pull ${img.image}`,
          backend: 'docker',
        },
      ];
    }
  }

  const run = (argv: string[]): RunResult => {
    const wrapped = wrap(policy, argv, { worktree, scratch, env: {}, stateDir });
    if (wrapped.failed) return { started: false, note: wrapped.note, backend: wrapped.backend };
    // cwd must be the worktree. With seatbelt we keep our own folder, which
    // is outside the cage, so a test would fail for the wrong reason.
    const r = spawnSync(wrapped.argv[0], wrapped.argv.slice(1), {
      cwd: worktree,
      encoding: 'utf8',
      timeout: 60_000,
    });
    return {
      started: true,
      ok: r.status === 0,
      output: (r.stderr || r.stdout || '').trim(),
      backend: wrapped.backend,
    };
  };

  // CONTROL. It has to prove the thing the coder really needs, which is git.
  // Proving that "some process can start" is not enough.
  const control = run(['git', 'status']);
  const controlOk = control.started && control.ok;
  // We check for a field, not a boolean, because type narrowing across
  // if/else is not reliable with strictNullChecks off (see tsconfig.json).
  let controlDetail: string;
  if (controlOk) {
    controlDetail = 'worked, as it should';
  } else if ('output' in control) {
    controlDetail = `failed: ${control.output.slice(0, 140)}`;
  } else {
    controlDetail = control.note;
  }
  results.push({
    label: 'git works inside the cage',
    pass: controlOk,
    detail: controlDetail,
    backend: control.backend,
  });

  const mustFailProbe = (label: string, argv: string[]): void => {
    if (!controlOk) {
      results.push({
        label,
        pass: null,
        detail: 'INCONCLUSIVE — the cage cannot run anything, so a block here proves nothing',
        backend: backend.name,
      });
      return;
    }
    const r = run(argv);
    const ok = r.started && r.ok;
    results.push({
      label,
      pass: !ok,
      detail: ok ? 'IT WORKED — the wall is not up' : 'blocked, as it should be',
      backend: r.backend,
    });
  };

  mustFailProbe('read outside the box', ['ls', path.join(os.homedir(), '.ssh')]);

  // A REAL commit, which is what the shared-git narrowing is scoped for. `git status` above only
  // proves git can read. The narrowing shuts every path a commit does not need, so the only honest
  // way to know it did not shut one it DOES need is to make a commit and see.
  // Committed then undone with `git reset --soft HEAD~1`, so the probe leaves the branch exactly
  // where it found it. `--soft` keeps the work; nothing the coder wrote is touched.
  if (controlOk) {
    const probeFile = path.join(worktree, '.glafka-sandbox-probe');
    let committed: RunResult | null = null;
    try {
      fs.writeFileSync(probeFile, `guardrails --test ${new Date().toISOString()}\n`);
      // Staged from inside the cage too: `git add` writes the worktree's own index, which is one of the
      // paths the narrowing gives back, so this is part of what is under test rather than setup.
      const staged = run(['git', 'add', '--', probeFile]);
      // `-n` skips hooks: .git/hooks is denied on purpose, and a project's own
      // pre-commit failing would report the wall as broken when it is not.
      committed =
        staged.started && staged.ok
          ? run(['git', 'commit', '-n', '-m', 'glafka guardrails --test probe', '--', probeFile])
          : staged;
    } catch (err) {
      committed = { started: false, note: (err as Error).message, backend: backend.name };
    }
    const ok = committed.started && committed.ok;
    results.push({
      label: 'git commit works in the cage',
      pass: ok,
      detail: ok
        ? 'committed to this ticket’s own branch, as it must'
        : `FAILED — the shared .git narrowing is too tight for a real commit: ${
            'output' in committed ? committed.output.slice(0, 180) : committed.note
          }`,
      backend: committed.backend,
    });
    // Put the branch back where it was, whether or not the commit landed.
    if (ok) spawnSync('git', ['reset', '--soft', 'HEAD~1'], { cwd: worktree, stdio: 'ignore' });
    spawnSync('git', ['restore', '--staged', '--', probeFile], { cwd: worktree, stdio: 'ignore' });
    try {
      fs.rmSync(probeFile, { force: true });
    } catch {
      // Leaving one file behind must not fail the whole report.
    }
  }

  // The other half of the same narrowing: the paths it is supposed to shut. Without this, a narrowing
  // that silently stopped applying would still show every test above passing.
  const sharedGit = path.join(findRepoRoot(worktree), '.git');
  const writeProbe = (target: string): string[] => ['sh', '-c', `echo x >> '${target}'`];

  // Shut on BOTH backends: a commit never writes the main checkout's HEAD.
  mustFailProbe("write the main checkout's HEAD", writeProbe(path.join(sharedGit, 'HEAD')));

  // Shut on seatbelt only. Docker cannot express "this directory is read-only except for these two
  // names", which is what giving one ref back needs — see the mount block in wrap(). Reported as a
  // fact rather than a failure, so a docker user is told which of the two narrowings they actually
  // got.
  const otherBranchRef = path.join(sharedGit, 'refs', 'heads', 'glafka-test-probe-not-a-branch');
  if (backend.name === 'seatbelt') {
    mustFailProbe("write another branch's ref", writeProbe(otherBranchRef));
  } else if (controlOk) {
    results.push({
      label: "write another branch's ref",
      pass: null,
      detail:
        'NOT SHUT on docker — a bind mount cannot make one file writable inside a read-only ' +
        'directory, and git needs to create <ref>.lock beside the ref. HEAD, index, packed-refs, ' +
        'logs/HEAD and info/ ARE shut here. Seatbelt narrows this the whole way.',
      backend: backend.name,
    });
  }

  if (!policy.sandbox.network) {
    // A DNS lookup is enough. We do not need to fetch anything.
    mustFailProbe('reach the network', [
      'node',
      '-e',
      "require('node:dns').promises.resolve('example.com').then(()=>process.exit(0),()=>process.exit(1))",
    ]);
  }

  // The default image has no `claude` or `gemini` binary at all, and no test
  // above would catch that. Only runs when we know the agent command.
  if (controlOk && agentCmd) {
    const bin = agentBinary(agentCmd);
    const probe = run(['sh', '-c', `command -v ${bin}`]);
    const found = probe.started && probe.ok;
    results.push({
      label: 'agent CLI present',
      pass: found,
      detail: found
        ? `found "${bin}" on PATH inside the cage`
        : `"${bin}" not found inside the cage (backend: ${backend.name}) — the configured image/host has no such binary; see docs/glafka/guardrails.json's sandbox.image`,
      backend: probe.backend,
    });

    // Not a pass or fail, just a fact about this level.
    // Only worth saying once the binary itself is there.
    if (found && !policy.sandbox.network) {
      results.push({
        label: 'agent CLI can reach its API',
        pass: null,
        detail:
          'UNKNOWN, and not fixable by any image change — this level denies all network, always (neverOverridable). ' +
          'A hosted-model CLI (Claude, Gemini, a hosted OpenAI-compatible endpoint, ...) cannot reach its API from ' +
          'inside this cage no matter what is installed in it. Only a fully local/offline model can actually run at this level.',
        backend: backend.name,
      });
    }
  }

  return results;
}

export function describe(policy: Pick<Policy, 'sandbox'>): string[] {
  const cfg = policy.sandbox;
  if (!cfg.enabled) {
    return ['off — no wall. every other layer here is a doorman, and beatable.'];
  }
  const backend = pickBackend(policy);
  return [
    `backend: ${backend.name}${backend.available ? '' : '  ← NOT AVAILABLE'}  (${backend.why})`,
    `  network inside the box: ${cfg.network ? 'open' : 'none'}`,
    `  extra mounts: ${(cfg.extraMounts ?? []).length}`,
    // Said here rather than left to be discovered.
    `  the repo's shared .git folder, narrowed to what committing needs:`,
    `    writable  objects/, this ticket's own branch ref + reflog, the stash,`,
    `              and this ticket's own folder under .git/worktrees/`,
    `    SHUT      every OTHER branch, HEAD, index, logs/, packed-refs, info/,`,
    `              hooks/, config, config.worktree, other tickets' worktrees`,
    `    A worktree on a DETACHED HEAD has no branch ref to give back, so`,
    `    nothing is narrowed there and the whole shared .git stays writable.`,
    `  verify it for real: glafka guardrails --test  (it runs a real git commit)`,
  ];
}
