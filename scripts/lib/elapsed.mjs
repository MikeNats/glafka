// Node's test reporter ends with `# duration_ms 259873.41`, which nobody
// can read at a glance. We print our own line in minutes and seconds.
export function formatElapsed(ms) {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

// Runs `fn`, then prints how long the whole run took.
export function reportElapsed(label, fn) {
  const started = Date.now();
  try {
    return fn();
  } finally {
    console.log(`\n${label} took ${formatElapsed(Date.now() - started)}`);
  }
}
