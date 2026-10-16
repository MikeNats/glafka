import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cbmAvailable, cbmBinPath, cbmInstallDir } from '../../memory/cbm.js';
import { RELEASES, RELEASE_FILES, CBM_ABOUT } from './codeGraphReleases.js';

// The code graph tool odysse and the agents' prompts use. Its own installer is never run,
// because it also rewrites the settings of every AI app it finds.
const ABOUT = `  ${CBM_ABOUT}`;
const DOWNLOAD_TIMEOUT_MS = 600_000;

// The license files travel with the binary: MIT asks for the notice to be kept.
const KEEP_FILES = ['LICENSE', 'THIRD_PARTY_NOTICES.md'];

export type RunTool = (bin: string, args: string[]) => void;

const defaultRunTool: RunTool = (bin, args) => {
  execFileSync(bin, args, { stdio: 'pipe', timeout: DOWNLOAD_TIMEOUT_MS });
};

function sha256Of(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// Download, check, unpack, copy into glafka's own folder. Throws with a reason a person can act on.
function fetchRelease(home: string, run: RunTool): void {
  const release = RELEASE_FILES[`${process.platform}-${process.arch}`];
  if (!release) throw new Error(`no release for ${process.platform}-${process.arch}`);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'glafka-code-graph-'));
  try {
    const archive = path.join(scratch, release.file);
    run('curl', ['-fsSL', '-o', archive, `${RELEASES}/${release.file}`]);
    if (sha256Of(archive) !== release.sha256) {
      throw new Error(`${release.file} does not match its published SHA-256, refused`);
    }
    const unpacked = path.join(scratch, 'unpacked');
    fs.mkdirSync(unpacked);
    run('tar', ['-xf', archive, '-C', unpacked]);
    const dest = cbmInstallDir(home);
    fs.mkdirSync(dest, { recursive: true });
    const bin = path.basename(cbmBinPath(home));
    fs.copyFileSync(path.join(unpacked, bin), cbmBinPath(home));
    fs.chmodSync(cbmBinPath(home), 0o755);
    for (const name of KEEP_FILES) {
      const from = path.join(unpacked, name);
      if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dest, name));
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// Installs the pinned copy unless it is already there, and says what happened. Never throws:
// an optional tool that fails must not fail the install around it.
export function installCodeGraph({
  home = os.homedir(),
  run = defaultRunTool,
}: { home?: string; run?: RunTool } = {}): string[] {
  if (fs.existsSync(cbmBinPath(home))) {
    return ['', 'code map', '  already installed: odysse maps the code with no AI', ABOUT];
  }
  try {
    fetchRelease(home, run);
  } catch (err) {
    fs.rmSync(cbmBinPath(home), { force: true });
    return [
      '',
      '⚠ code map not installed',
      `  ${(err as Error).message.split('\n')[0]}`,
      '  odysse falls back to an AI-written map. Try again later, or skip it: --no-code-graph',
      ABOUT,
    ];
  }
  const works = cbmAvailable({ home });
  return [
    '',
    'code map',
    works
      ? `  installed in ${cbmInstallDir(home)}: odysse maps the code with no AI`
      : `  installed in ${cbmInstallDir(home)}, but it does not start on this machine`,
    '  skip it: --no-code-graph',
    ABOUT,
  ];
}
