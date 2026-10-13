import fs from 'node:fs';

// A coder log can be megabytes and the usage block sits at the end, so we
// read only the end of it.
const DEFAULT_TAIL_BYTES = 64 * 1024;

// Null when there is no log — a run that never started, or one already
// reaped. Null means unmeasured, which is what the caller records.
export function logTail(filePath: string, maxBytes: number = DEFAULT_TAIL_BYTES): string | null {
  let handle: number | null = null;
  try {
    const size = fs.statSync(filePath).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    handle = fs.openSync(filePath, 'r');
    fs.readSync(handle, buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } catch {
    return null;
  } finally {
    if (handle !== null) fs.closeSync(handle);
  }
}
