// A ticket id is the day it was made plus the idea, so a folder of them reads
// as work rather than as hashes. No dots and no slashes, so it is path-safe.
export const TICKET_ID_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/;

// The longest slug we keep. The date and separator add 11 more.
const MAX_SLUG = 40;

export function assertValidTicketId(id: string): void {
  if (!TICKET_ID_RE.test(id)) {
    throw new Error(`invalid ticket id: ${JSON.stringify(id)}`);
  }
}

// A title cut down to something safe in a name: lowercase, hyphens only,
// trimmed, short. Empty when the text has nothing usable in it.
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/g, '');
}

// The id for a new ticket. Null when the idea has no usable characters —
// a bare date is not a name, and the caller has to ask for words.
export function buildTicketId(
  idea: string,
  { now = new Date() }: { now?: Date } = {},
): string | null {
  const slug = slugify(idea);
  if (slug === '') return null;
  return `${now.toISOString().slice(0, 10)}-${slug}`;
}
