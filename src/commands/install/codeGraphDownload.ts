import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cbmBinPath, cbmInstallDir } from '../../memory/cbm.js';
import { RELEASES, RELEASE_FILES } from './codeGraphReleases.js';

export const DOWNLOAD_TIMEOUT_MS = 600_000;

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
function fetchRelease(home: string, run: RunTool, onArchive: (file: string) => void): void {
  const release = RELEASE_FILES[`${process.platform}-${process.arch}`];
  if (!release) throw new Error(`no release for ${process.platform}-${process.arch}`);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'glafka-code-graph-'));
  try {
    const archive = path.join(scratch, release.file);
    onArchive(archive);
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

// While a download runs: its pid, and the archive file as it grows. After a failure: why.
const markerPath = (home: string) => `${cbmInstallDir(home)}.download.json`;
export const errorPath = (home: string) => `${cbmInstallDir(home)}.error`;

export function runningDownload(home: string): { pid: number; archive: string } | null {
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath(home), 'utf8'));
    process.kill(marker.pid, 0);
    return marker;
  } catch {
    return null;
  }
}

// The background job itself (codeGraphWorker.js). Never throws: a failure is written down instead.
export function downloadCodeGraph(home: string, run: RunTool = defaultRunTool): void {
  fs.rmSync(errorPath(home), { force: true });
  fs.mkdirSync(path.dirname(markerPath(home)), { recursive: true });
  const mark = (archive: string) =>
    fs.writeFileSync(markerPath(home), JSON.stringify({ pid: process.pid, archive }));
  mark('');
  try {
    fetchRelease(home, run, mark);
  } catch (err) {
    fs.rmSync(cbmBinPath(home), { force: true });
    fs.writeFileSync(errorPath(home), (err as Error).message.split('\n')[0]!);
  } finally {
    fs.rmSync(markerPath(home), { force: true });
  }
}
