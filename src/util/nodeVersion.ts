import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Version = [number, number, number];

const compare = (a: Version, b: Version): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const show = (v: Version): string => v.join('.');
const part = (s: string | undefined): number => (s && /^\d+$/.test(s) ? Number(s) : 0);

// The lowest version a range allows: "^22.12.0", ">=22", "22.x", "^18 || >=20" → the smallest.
// A form not read here gives null, so there is no check and never a false alarm.
function lowest(range: string): Version | null {
  let best: Version | null = null;
  for (const alternative of range.split('||')) {
    const m = /^(>=|>|\^|~|=)?\s*v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/.exec(
      alternative.trim(),
    );
    if (!m) return null;
    const v: Version = [Number(m[2]), part(m[3]), part(m[4])];
    if (best === null || compare(v, best) < 0) best = v;
  }
  return best;
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
}

function enginesNode(dir: string): string | null {
  try {
    const pkg = JSON.parse(readText(path.join(dir, 'package.json')) ?? '{}') as {
      engines?: { node?: unknown };
    };
    return typeof pkg.engines?.node === 'string' ? pkg.engines.node : null;
  } catch {
    return null;
  }
}

// What the project asks for, from .nvmrc, .node-version and package.json "engines". The
// strictest wins: an .nvmrc of "22" next to engines "^22.22.2" still needs 22.22.2.
function required(dir: string): { min: Version; from: string } | null {
  const range = enginesNode(dir);
  const sources: [string, string | null][] = [
    ['.nvmrc', readText(path.join(dir, '.nvmrc'))],
    ['.node-version', readText(path.join(dir, '.node-version'))],
    [`package.json engines "${range}"`, range],
  ];
  let need: { min: Version; from: string } | null = null;
  for (const [from, text] of sources) {
    const min = text ? lowest(text) : null;
    if (min && (need === null || compare(min, need.min) > 0)) need = { min, from };
  }
  return need;
}

// Null when this Node is new enough. Otherwise the message a person needs: glafka changes nothing
// itself, because which Node a machine uses is that person's call.
export function nodeProblem(dir: string, current: string = process.version): string | null {
  const need = required(dir);
  const have = lowest(current);
  if (!need || !have || compare(have, need.min) >= 0) return null;
  const major = need.min[0];
  const fix = fs.existsSync(path.join(os.homedir(), '.nvm'))
    ? `nvm install ${major} && nvm alias default ${major}`
    : `install Node ${show(need.min)} or newer from https://nodejs.org`;
  return (
    `this project needs Node ${show(need.min)} or newer (${need.from}), but you have ` +
    `${show(have)}. Update Node, then run this again:\n  ${fix}`
  );
}
