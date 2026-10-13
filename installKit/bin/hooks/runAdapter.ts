import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { HOOK_ADAPTER_FILES } from './install.js';

// Two layouts. The npm package keeps the built adapters under dist/; install vendors
// them into .glafka/, where there is no dist/ at all. A hook that cannot load denies
// every tool call, so guessing one layout takes the whole agent down.
export function resolveAdapterPath(packageRoot: string, adapterFile: string): string {
  const inPackage = path.join(packageRoot, 'dist', 'installKit', 'guardrails', adapterFile);
  if (fs.existsSync(inPackage)) return inPackage;
  const vendored = path.join(packageRoot, 'installKit', 'guardrails', adapterFile);
  if (fs.existsSync(vendored)) return vendored;
  // Neither. Name the package path — it is the one a broken install is missing.
  return inPackage;
}

// Runs a hook adapter inside this process, instead of starting a second one, which would be slow on every tool call.
export async function runHookAdapter({
  args,
  packageRoot,
}: {
  args: string[];
  packageRoot: string;
}): Promise<void> {
  try {
    const adapter = args[1];
    const adapterFile = adapter ? HOOK_ADAPTER_FILES[adapter] : undefined;
    if (!adapterFile) {
      throw new Error(`--run-hook needs one of: ${Object.keys(HOOK_ADAPTER_FILES).join(', ')}`);
    }
    const { main } = await import(pathToFileURL(resolveAdapterPath(packageRoot, adapterFile)).href);
    main();
  } catch (err) {
    const reason = `guardrails: hook dispatcher failed to load — denying (${(err as Error).message})`;
    process.stdout.write(`${JSON.stringify({ decision: 'block', reason })}\n`);
    process.stderr.write(`${reason}\n`);
    process.exit(2);
  }
}
