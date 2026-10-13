import fs from 'node:fs';
import path from 'node:path';
import { isValidSessionId } from './session.js';

// Under a third of the 13.2 MB session that prompted this, so it fires while
// the session is still worth saving and is not a nag on an ordinary ticket.
export const SESSION_SIZE_WARN_BYTES = 4 * 1024 * 1024;

const WARNED_DIR = 'sessions';

// One marker per session that has already been told. Beside the claim markers,
// which are keyed the same way.
function warnedMarker(stateDir: string, sessionId: string): string | null {
  if (!isValidSessionId(sessionId)) return null;
  return path.join(stateDir, WARNED_DIR, `${sessionId}.size-warned`);
}

// The message to show, or null when there is nothing to say. Never throws:
// this runs before every tool call and must not be able to block one.
export function sessionSizeWarning({
  stateDir,
  sessionId,
  transcriptPath,
}: {
  stateDir: string;
  sessionId: string | null;
  transcriptPath: string | null;
}): string | null {
  // No id means no way to warn only once, and a warning on every tool call is
  // worse than none.
  if (!sessionId || !transcriptPath) return null;

  const marker = warnedMarker(stateDir, sessionId);
  if (!marker) return null;

  try {
    if (fs.existsSync(marker)) return null;

    // statSync, never a read. The transcript that prompted this was 13.2 MB.
    const bytes = fs.statSync(transcriptPath).size;
    if (bytes < SESSION_SIZE_WARN_BYTES) return null;

    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, `${new Date().toISOString()}\n`);

    const mb = (bytes / (1024 * 1024)).toFixed(1);
    return (
      `glafka: this session's transcript is ${mb} MB. Every turn re-sends all of it, ` +
      `so cost grows with the square of the turn count.\n` +
      `  Finish the step you are on, then start a fresh session.\n` +
      `  Record anything decided out loud first: glafka apofasi <ticket-id> "<what was decided>"\n` +
      `  Pick the ticket back up with: glafka vima`
    );
  } catch {
    // A transcript we cannot stat is not a session we should block.
    return null;
  }
}
