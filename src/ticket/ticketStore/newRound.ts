import crypto from 'node:crypto';
import { clearReviewFindings, setReviewToken } from './review.js';
import { clearNotified } from './runState.js';

// A new round starts clean: old findings, the "a person was told" mark and the old review
// token go. Returns this round's review token. Only a real reviewer ever sees it.
export function startCleanRound(stateDir: string, id: string): string {
  clearReviewFindings(stateDir, id);
  clearNotified(stateDir, id);
  const token = crypto.randomBytes(16).toString('hex');
  setReviewToken(stateDir, id, token);
  return token;
}
