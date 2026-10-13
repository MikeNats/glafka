import fs from 'node:fs';

// Reads the terminal, not the input stream, so a pipe is not read as "no".
// Anything except y or yes counts as no.
export function askYesNo(question: string): boolean {
  process.stderr.write(`${question} [y/N] `);
  let fd;
  try {
    fd = fs.openSync('/dev/tty', 'rs');
  } catch {
    process.stderr.write('\n');
    return false;
  }
  try {
    const buf = Buffer.alloc(64);
    const bytes = fs.readSync(fd, buf, 0, buf.length, null);
    const answer = buf.subarray(0, bytes).toString('utf8').trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } catch {
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

// Checks the terminal, not the input stream.
// The input can be a pipe even when a real terminal is there.
export function hasTty(): boolean {
  try {
    fs.closeSync(fs.openSync('/dev/tty', 'rs'));
    return true;
  } catch {
    return false;
  }
}
