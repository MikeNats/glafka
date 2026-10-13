import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Policy } from '../../types/policy.js';

export const DEFAULT_IMAGE = 'node:22';

// Is this command on PATH? Resolved directly rather than through a shell. This used to be
// `spawnSync('command', ['-v', cmd], { shell: true })`. `command -v` is a POSIX shell builtin, and
// `{ shell: true }` runs %ComSpec% — cmd.exe — on Windows, which has no such builtin. So the answer
// there was always "no", including on a machine with Docker Desktop running: docker was never
// detected, level 4 refused every ticket, and `--backends` reported "docker is not installed" about
// a daemon that was up. The same rule src/util/shell.ts states applies here: on Windows, cmd.exe
// does not fail loudly, it means something else.
function has(cmd: string): boolean {
  // PATHEXT is what makes `docker` find `docker.exe`. Windows only.
  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : [''];

  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = path.join(dir, `${cmd}${extension}`);
      try {
        // Executable for somebody. X_OK is not meaningful on Windows, where any
        // file with a PATHEXT suffix is runnable, so existence is the test there.
        if (!fs.statSync(candidate).isFile()) continue;
        if (process.platform !== 'win32') fs.accessSync(candidate, fs.constants.X_OK);
        return true;
      } catch {
        // Not here, or not runnable. Keep looking.
      }
    }
  }
  return false;
}

function dockerUsable(): { ok: boolean; why?: string } {
  if (!has('docker')) return { ok: false, why: 'docker is not installed' };
  // Installed is not the same as running. `docker info` is the real test.
  const r = spawnSync('docker', ['info'], { stdio: 'ignore' });
  return r.status === 0
    ? { ok: true }
    : { ok: false, why: 'docker is installed but the daemon is not running' };
}

interface SandboxBackend {
  name: string;
  available: boolean;
  why: string;
  strength?: string;
}

export function detect(): SandboxBackend[] {
  const backends: SandboxBackend[] = [];

  const docker = dockerUsable();
  backends.push({
    name: 'docker',
    available: docker.ok,
    why: docker.why ?? 'ready',
    strength: 'strong — separate filesystem and network namespace',
  });

  const isMac = os.platform() === 'darwin';
  backends.push({
    name: 'seatbelt',
    available: isMac && has('sandbox-exec'),
    why: isMac
      ? has('sandbox-exec')
        ? 'ready (Apple deprecated it but it still works — prove it with --test)'
        : 'sandbox-exec not found'
      : 'macOS only',
    strength: 'good — kernel-enforced, but the profile language is fiddly',
  });

  return backends;
}

export function pickBackend(policy: Pick<Policy, 'sandbox'>): SandboxBackend {
  const wanted = policy.sandbox.backend;
  const found = detect();

  if (wanted !== 'auto') {
    const b = found.find((x) => x.name === wanted);
    if (!b) return { name: 'none', available: false, why: `unknown backend "${wanted}"` };
    return b;
  }

  // Try docker first, since it is stronger. Then seatbelt. Then nothing.
  return (
    found.find((b) => b.name === 'docker' && b.available) ??
    found.find((b) => b.name === 'seatbelt' && b.available) ?? {
      name: 'none',
      available: false,
      why: 'no sandbox backend available on this machine',
    }
  );
}
