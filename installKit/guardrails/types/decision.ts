// The answer a layer gives, and the answer we give after asking them all.
// It is written to the log, and it is what the caller acts on.
export interface Decision {
  allow: boolean;
  layer?: string | null;
  reason: string;
  weak?: boolean;
  needsHuman?: boolean;
}
