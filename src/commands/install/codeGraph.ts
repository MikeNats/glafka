import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { cbmBinPath, cbmInstallDir } from '../../memory/cbm.js';
import { CBM_ABOUT } from './codeGraphReleases.js';
import { DOWNLOAD_TIMEOUT_MS, errorPath, runningDownload } from './codeGraphDownload.js';

// The code graph tool odysse and the agents' prompts use. Its own installer is never run,
// because it also rewrites the settings of every AI app it finds.
const ABOUT = `  ${CBM_ABOUT}`;
const WORKER = fileURLToPath(new URL('./codeGraphWorker.js', import.meta.url));

export type StartDownload = (home: string) => void;

const startInBackground: StartDownload = (home) => {
  spawn(process.execPath, [WORKER, home], { detached: true, stdio: 'ignore' }).unref();
};

// Starts the pinned copy's download in the background unless it is there, and says so.
// Install does not wait for 50 MB: odysse does, and shows how far it got.
export function installCodeGraph({
  home = os.homedir(),
  start = startInBackground,
}: { home?: string; start?: StartDownload } = {}): string[] {
  if (fs.existsSync(cbmBinPath(home))) {
    return ['', 'code map', '  already installed: odysse maps the code with no AI', ABOUT];
  }
  if (!runningDownload(home)) start(home);
  return [
    '',
    'code map',
    `  downloading in the background into ${cbmInstallDir(home)}`,
    '  odysse waits for it. Skip it: --no-code-graph',
    ABOUT,
  ];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// odysse needs the tool: waits for a download install started, saying how far it got. Returns
// why the download failed, or null.
export async function waitForCodeGraph({
  home = os.homedir(),
  say = (line: string) => console.error(line),
  timeoutMs = DOWNLOAD_TIMEOUT_MS,
}: { home?: string; say?: (line: string) => void; timeoutMs?: number } = {}): Promise<
  string | null
> {
  const until = Date.now() + timeoutMs;
  let shown = 0;
  for (let job = runningDownload(home); job && Date.now() < until; job = runningDownload(home)) {
    if (Date.now() - shown > 5000) {
      const bytes = job.archive && fs.existsSync(job.archive) ? fs.statSync(job.archive).size : 0;
      say(`odysse: downloading the code map tool… ${Math.round(bytes / 1e6)} MB so far`);
      shown = Date.now();
    }
    await sleep(500);
  }
  return fs.existsSync(errorPath(home)) ? fs.readFileSync(errorPath(home), 'utf8') : null;
}
