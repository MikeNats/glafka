import fs from 'node:fs';
import path from 'node:path';
import { globToRegExp } from '../../installKit/guardrails/index.js';
import { ethosPath, readDoc, writeDoc } from './docsStore.js';
import { loadCategories, targetOf, categoryByTarget, flagOf } from './categories.js';
import type { Category } from '../types/promptContext.js';
import type { EthosCandidate } from '../types/ticket.js';

// Four sections: Authored is yours, Proposed is a guess, Learned is approved,
// Dropped is what you turned down — kept so a wrong pick can be undone.
export const AUTHORED_HEADING = '## Authored';
export const PROPOSED_HEADING = '## Proposed';
export const LEARNED_HEADING = '## Learned';
export const DROPPED_HEADING = '## Dropped';

// Only these two are policy. Everything else in the file — Proposed, Dropped, or
// a heading someone added by hand — is held back from every prompt.
const IN_FORCE_HEADINGS = [AUTHORED_HEADING, LEARNED_HEADING];

function normalize(line: string): string {
  return line.replace(/^- /, '').trim().toLowerCase();
}

// A new, empty file: every heading, plus a short hint.
function emptyDoc(target: string, hint: string | null): string {
  const hintLine = hint ? `\n${hint}\n` : '';
  return (
    `# ${target}\n${hintLine}\n` +
    `${AUTHORED_HEADING}\n\n` +
    `<!-- Your rules. Write them here by hand, or say them out loud and\n` +
    `     approve the candidate. glafka never edits this section. -->\n\n` +
    `${PROPOSED_HEADING}\n\n` +
    `<!-- Conventions odysse observed in the code. Not in force until you\n` +
    `     move one up into Authored. Delete what you disagree with. -->\n\n` +
    `${LEARNED_HEADING}\n\n` +
    `${DROPPED_HEADING}\n\n` +
    `<!-- Rules you turned down at the gate. Not in force, and never sent to\n` +
    `     any agent. Kept so a wrong pick can be moved back up by hand. -->\n\n`
  );
}

function bulletsOf(body: string): string[] {
  return body
    .split('\n')
    .map((line) => line.match(/^- (.+)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => m[1]!.trim())
    .filter((text) => text !== '');
}

// Drops every section that is not policy, keeping the title and hint above them.
// A whitelist on purpose: stripping only Proposed meant any other heading — one a
// person added by hand, since the file invites that — became policy in silence.
function inForceOnly(text: string): string {
  return text
    .split(/\n(?=## )/)
    .filter((section, i) => {
      if (i === 0 && !section.startsWith('## ')) return true;
      return IN_FORCE_HEADINGS.some((heading) => section.startsWith(heading));
    })
    .join('\n');
}

// Rules can have a scope: [scope: **/migrations/**] to apply only to certain files.
// Unscoped rules always apply.
const SCOPE_RE = /^\[scope:\s*([^\]]+)\]\s*(.*)$/;

export function parseScope(text: string): { scope: string | null; text: string } {
  const match = text.match(SCOPE_RE);
  if (!match) return { scope: null, text };
  return { scope: match[1]!.trim(), text: match[2]!.trim() };
}

// Returns true if rule has no scope or its scope matches paths. Pass null paths when unknown.
// Null means "send everything" — filtering empty list would silently drop needed rules.
function keepsRule(line: string, paths: string[] | null): boolean {
  const bullet = line.match(/^- (.+)$/);
  if (!bullet) return true; // headings, blank lines, comments
  const { scope } = parseScope(bullet[1]!.trim());
  if (scope === null) return true;
  if (paths === null) return true;
  const pattern = globToRegExp(scope);
  return paths.some((p) => pattern.test(p.split(path.sep).join('/')));
}

// Drops the `[scope: ...]` marker once a rule has been kept. The agent is
// being told a rule, not how the rule was selected.
function stripScopeMarkers(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const bullet = line.match(/^- (.+)$/);
      if (!bullet) return line;
      const { text: rule } = parseScope(bullet[1]!.trim());
      return `- ${rule}`;
    })
    .join('\n');
}

// Extract file paths from plan/ticket text. Returns null when none found (safer than empty filter).
// Null = "send everything" — silent empty filter hides needed rules.
const PATH_RE = /(?:^|[\s`'"(\[])((?:[\w.@-]+\/)+[\w.@*-]+)/g;

export function pathsNamedIn(text: string | null | undefined): string[] | null {
  if (!text) return null;
  const found = new Set<string>();
  for (const match of text.matchAll(PATH_RE)) {
    const candidate = match[1]!.replace(/[.,;:)\]]+$/, '');
    // A bare "and/or" is not a path. Two segments with no dot and no known
    // folder shape is more likely prose than a file.
    if (!candidate.includes('.') && candidate.split('/').length < 3) continue;
    found.add(candidate);
    // Also record the folders above it, so a rule scoped to `src/db/**`
    // matches a plan that names `src/db/migrate.ts`.
    const parts = candidate.split('/');
    for (let i = 1; i < parts.length; i += 1) found.add(parts.slice(0, i).join('/') + '/');
  }
  return found.size > 0 ? [...found] : null;
}

// Read all ethos rules for the repo. Pass paths to filter by file scope, or null to get all rules.
export function readEthosDocs(repoRoot: string, paths: string[] | null = null): string | null {
  const parts: string[] = [];
  for (const category of loadCategories(repoRoot)) {
    const filePath = ethosPath(repoRoot, targetOf(category));
    if (!fs.existsSync(filePath)) continue;
    const inForce = inForceOnly(readDoc(filePath)).trim();
    const scoped = inForce
      .split('\n')
      .filter((line) => keepsRule(line, paths))
      .join('\n');
    // Skip files that have headings but no rules left after filtering.
    if (bulletsOf(scoped).length > 0) parts.push(stripScopeMarkers(scoped).trim());
  }
  return parts.length > 0 ? parts.join('\n\n') : null;
}

// Adds lines at the end of the section, not the end of the file.
// Returns null if the heading is not there.
function insertIntoSection(text: string, heading: string, lines: string): string | null {
  const idx = text.indexOf(heading);
  if (idx === -1) return null;
  const start = idx + heading.length;
  const next = text.indexOf('\n## ', start);
  const sectionEnd = next === -1 ? text.length : next;
  const head = text.slice(0, sectionEnd).trimEnd();
  // After an existing bullet = no gap (join list). Otherwise = blank line (separate).
  const gap = /\n- .*$/.test(head) ? '\n' : '\n\n';
  return `${head}${gap}${lines}\n${text.slice(sectionEnd)}`;
}

// Adds lines under a heading, creating it at the end for files written
// before that heading existed.
export function appendToSection(text: string, heading: string, lines: string): string {
  return insertIntoSection(text, heading, lines) ?? `${text.trimEnd()}\n\n${heading}\n\n${lines}\n`;
}

// Every caller only ever passes a target and a text, so we ask for
// just those two fields, not the whole object.
type EthosCandidateDraft = Pick<EthosCandidate, 'target' | 'text'>;

// Saves approved rules under "## Learned" — the section that IS in force.
// NOT AN API. Calling this yourself writes rules no person ever approved.
export function promoteEthosCandidates(
  repoRoot: string,
  candidates: EthosCandidateDraft[] | null | undefined,
): void {
  if (!candidates || candidates.length === 0) return;
  const categories = loadCategories(repoRoot);

  const byTarget = new Map<string, string[]>();
  for (const candidate of candidates) {
    if (!byTarget.has(candidate.target)) byTarget.set(candidate.target, []);
    byTarget.get(candidate.target)!.push(candidate.text);
  }

  for (const [target, texts] of byTarget) {
    const filePath = ethosPath(repoRoot, target);
    const hint = categoryByTarget(categories, target)?.hint ?? null;
    const existing = fs.existsSync(filePath) ? readDoc(filePath) : emptyDoc(target, hint);

    // "Already known" means already in force. Reading the whole file would let a
    // rule sitting under ## Dropped block the same rule being approved now.
    const seen = new Set(inForceOnly(existing).split('\n').map(normalize).filter(Boolean));
    const newTexts: string[] = [];
    for (const text of texts) {
      const key = normalize(text);
      if (seen.has(key)) continue;
      seen.add(key);
      newTexts.push(text);
    }
    if (newTexts.length === 0) continue;

    const additions = newTexts.map((text) => `- ${text}`).join('\n');
    const inserted = insertIntoSection(existing, LEARNED_HEADING, additions);
    if (inserted === null) {
      // No Learned heading yet. Add one, so nothing is lost.
      writeDoc(filePath, `${existing.trimEnd()}\n\n${LEARNED_HEADING}\n\n${additions}\n`);
      continue;
    }
    writeDoc(filePath, inserted.replace(/\n{3,}/g, '\n\n'));
  }
}

// Writes glafka's shipped starter rules under "## Authored" — the section a person owns.
//
// APPEND, never replace. That section can already hold rules someone wrote by hand, and the file
// around it holds `## Learned` rules glafka captured from this project's own tickets; rewriting
// either would throw away work nobody asked us to touch. Re-running is safe: a rule whose text is
// already in force is skipped, using the same normalise-and-compare the audit pass uses, so seeding
// twice adds nothing the second time.
//
// Writing to Authored rather than Learned is deliberate. Learned means "a person approved this at a
// gate", and nobody approved these — they arrived with an install. Authored means "the project's
// own rules", which is exactly what they become the moment someone runs the flag.
export function seedAuthoredRules(
  repoRoot: string,
  rulesByTarget: ReadonlyMap<string, readonly string[]>,
): { target: string; added: number; skipped: number }[] {
  const categories = loadCategories(repoRoot);
  const report: { target: string; added: number; skipped: number }[] = [];

  for (const [target, texts] of rulesByTarget) {
    // A project that renamed or dropped a category does not get a file invented for it.
    const category = categoryByTarget(categories, target);
    if (!category) continue;

    const filePath = ethosPath(repoRoot, target);
    const existing = fs.existsSync(filePath) ? readDoc(filePath) : emptyDoc(target, category.hint);

    // In force, not the whole file: a rule sitting under ## Dropped was turned down on purpose, and
    // must not be re-added by an install — but it also must not silently block being re-added by a
    // person, which is why Dropped is excluded from `seen` rather than treated as a match.
    const seen = new Set(inForceOnly(existing).split('\n').map(normalize).filter(Boolean));
    const fresh: string[] = [];
    for (const text of texts) {
      const key = normalize(text);
      if (key === '' || seen.has(key)) continue;
      seen.add(key);
      fresh.push(text.trim());
    }

    report.push({ target, added: fresh.length, skipped: texts.length - fresh.length });
    if (fresh.length === 0) continue;

    const additions = fresh.map((text) => `- ${text}`).join('\n');
    const inserted = insertIntoSection(existing, AUTHORED_HEADING, additions);
    // No Authored heading at all means a file written by hand in some other shape. Add the heading
    // rather than drop the rules, same as promoteEthosCandidates does for Learned.
    writeDoc(
      filePath,
      (inserted ?? `${existing.trimEnd()}\n\n${AUTHORED_HEADING}\n\n${additions}\n`).replace(
        /\n{3,}/g,
        '\n\n',
      ),
    );
  }
  return report;
}

// Adds a proposed rule. Returns false if it is already known.
// NOT AN API. Run `glafka odysse --propose` — this is where it ends up.
export function proposeEthos(
  repoRoot: string,
  { target, text }: { target: string; text: string },
): boolean {
  const trimmed = text.trim();
  if (trimmed === '') throw new Error('proposeEthos: empty rule text');
  if (trimmed.includes('\n')) {
    throw new Error('proposeEthos: rule text may not contain a newline — one rule is one line');
  }

  const filePath = ethosPath(repoRoot, target);
  const hint = categoryByTarget(loadCategories(repoRoot), target)?.hint ?? null;
  const existing = fs.existsSync(filePath) ? readDoc(filePath) : emptyDoc(target, hint);

  const seen = new Set(existing.split('\n').map(normalize).filter(Boolean));
  if (seen.has(normalize(trimmed))) return false;

  const inserted = insertIntoSection(existing, PROPOSED_HEADING, `- ${trimmed}`);
  if (inserted === null) {
    // An older file with no Proposed heading. Add one rather than lose the rule, and put it before
    // Learned so the order stays Authored/Proposed/ Learned.
    const withHeading = existing.includes(LEARNED_HEADING)
      ? existing.replace(
          LEARNED_HEADING,
          `${PROPOSED_HEADING}\n\n- ${trimmed}\n\n${LEARNED_HEADING}`,
        )
      : `${existing.trimEnd()}\n\n${PROPOSED_HEADING}\n\n- ${trimmed}\n`;
    writeDoc(filePath, withHeading.replace(/\n{3,}/g, '\n\n'));
    return true;
  }
  writeDoc(filePath, inserted.replace(/\n{3,}/g, '\n\n'));
  return true;
}

// The text of one section, or "" if it is not there.
function sectionBody(text: string, heading: string): string {
  const idx = text.indexOf(heading);
  if (idx === -1) return '';
  const start = idx + heading.length;
  const next = text.indexOf('\n## ', start);
  return text.slice(start, next === -1 ? text.length : next);
}

// Keeps the heading but empties it.
function clearSection(text: string, heading: string): string {
  const idx = text.indexOf(heading);
  if (idx === -1) return text;
  const start = idx + heading.length;
  const next = text.indexOf('\n## ', start);
  const tail = next === -1 ? '' : text.slice(next + 1);
  return `${text.slice(0, start)}\n\n${tail}`;
}

// A guess nobody has read yet, shown to a human later. It is a different shape from a ticket candidate: no status, and the
export interface EthosProposal {
  target: string;
  source: 'odysse';
  text: string;
}

// Every guess nobody has decided yet, in the same order as decideProposals.
export function readProposals(repoRoot: string): EthosProposal[] {
  const proposals: EthosProposal[] = [];
  for (const category of loadCategories(repoRoot)) {
    const target = targetOf(category);
    const filePath = ethosPath(repoRoot, target);
    if (!fs.existsSync(filePath)) continue;
    for (const text of bulletsOf(sectionBody(readDoc(filePath), PROPOSED_HEADING))) {
      proposals.push({ target, source: 'odysse', text });
    }
  }
  return proposals;
}

// Moves picked rules to Learned, the rest to Dropped. Numbers start at 1.
// NOT AN API. This answers a person's gate — run `glafka odysse --keep`.
export function decideProposals(
  repoRoot: string,
  keepIndexes: number[],
): { kept: EthosProposal[]; decided: number } {
  const keep = new Set(keepIndexes);
  const proposals = readProposals(repoRoot);
  if (proposals.length === 0) return { kept: [], decided: 0 };

  const kept = proposals.filter((_, i) => keep.has(i + 1));
  const dropped = proposals.filter((_, i) => !keep.has(i + 1));

  // Save FIRST, clear second. These are two separate writes, and clearing
  // first would lose every rule if the save then failed.
  promoteEthosCandidates(repoRoot, kept);

  for (const target of new Set(proposals.map((p) => p.target))) {
    const filePath = ethosPath(repoRoot, target);
    // A turned-down rule is written down, not deleted. One mistyped index used to
    // destroy a rule with no undo; now it can be moved back up by hand.
    const lines = dropped
      .filter((proposal) => proposal.target === target)
      .map((proposal) => `- ${proposal.text}`)
      .join('\n');
    const doc = readDoc(filePath);
    const withDropped = lines === '' ? doc : appendToSection(doc, DROPPED_HEADING, lines);
    writeDoc(filePath, clearSection(withDropped, PROPOSED_HEADING));
  }

  return { kept, decided: proposals.length };
}

// -------------------------------------------------------------------------- Prompt builder

// Rules are saved with `glafka psyche`. `--from you` means a person said it.

function commandLines(ticketId: string, categories: readonly Category[], cli: string): string {
  const width = Math.max(...categories.map((c) => flagOf(c).length));
  return categories
    .map((c) => `  ${cli} psyche ${ticketId} ${flagOf(c).padEnd(width)} "<rule>"   # ${c.hint}`)
    .join('\n');
}

// `stage` is the current step.
// `last` means this is the final step before a person looks.
export function buildEthosCaptureSection({
  ticketId,
  stage,
  categories,
  last = false,
  // How this agent can actually invoke glafka. See src/util/cli.ts — the bare
  // word is not reliably runnable from inside a spawned agent.
  cli = 'glafka',
}: {
  ticketId: string;
  stage: string;
  categories: readonly Category[];
  last?: boolean;
  cli?: string;
}): string {
  if (!categories || categories.length === 0) {
    throw new Error('buildEthosCaptureSection: no categories — nowhere to file a rule');
  }

  const closing = last
    ? `This is the last stage that records anything for this ticket. Everything
still undecided — from here and from the earlier stages — gets shown to the
human next, and they rule on it.`
    : `These are proposals, not decisions. They sit on the ticket until the
human rules on them after review.`;

  return `## Record what you learn (ethos)
Record as you go, not at the end. The moment one of these happens, run the
command — do not batch them up and do not wait until ${stage} is finished.

**When the human states a preference, makes a decision, or corrects you**,
record it immediately, in their words:

  ${cli} psyche ${ticketId} <category> "<what they said>"

That includes offhand remarks. "ugh, not another wrapper", "we always put
those in the adapter", "don't touch the migration files" are all rules. If you
are unsure whether they meant it as a rule, record it anyway and let them turn
it down — turning one down is one keystroke, and a preference you dropped is
gone.

**Do not reach for \`--from you\`.** That flag means a person typed the rule
themselves, and the CLI refuses it without a real terminal — it will fail on
you. Reporting what you heard is not the same as them saying it, and the
difference is the whole point of the gate: they confirm it.

**When you conclude something yourself** from working in this codebase, record
it the same way:

  ${cli} psyche ${ticketId} <category> "<rule>"

Categories in this project, and what belongs in each:

${commandLines(ticketId, categories, cli)}

If a rule only applies to part of the codebase, say where, and it is only
ever sent to work that touches those files:

  ${cli} psyche ${ticketId} <category> "[scope: **/migrations/**] <rule>"

Leave the scope off when a rule applies everywhere. Most do.

What makes a real candidate:
- It generalizes past this ticket. "Renamed the helper in parser.js" is not a
  convention; "helpers that touch the parser stay in parser/" is.
- Phrase it as an instruction someone can follow, not as a description of what
  happened.
- One rule per command. Do not batch several into one string.
- Skip anything already covered by the project rules section above —
  duplicates are dropped anyway, so they only add noise.
- For your OWN conclusions, recording nothing is a fine outcome. For things
  the human said, err toward recording.

${closing}`;
}
