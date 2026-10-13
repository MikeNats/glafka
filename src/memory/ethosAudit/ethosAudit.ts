import fs from 'node:fs';
import path from 'node:path';
import { ethosPath, readDoc, writeDoc } from '../../memory/docsStore.js';
import { loadCategories, targetOf } from '../../memory/categories.js';
import { listProjectFiles, listIgnoredEntries } from '../../util/git.js';
import {
  AUTHORED_HEADING,
  LEARNED_HEADING,
  PROPOSED_HEADING,
  DROPPED_HEADING,
  appendToSection,
} from '../../memory/ethos.js';

// Dedup is exact string match, so these both live forever, in every prompt: - Wrap errors at the
// boundary, never mid-call - Errors are wrapped at the boundary Nothing merges near-duplicates and nothing retires a rule that has gone stale. This is the one job an LLM is actually better at than code, so it gets one cheap pass and proposes; a person decides, as with every other proposal in glafka.

export const AUDIT_ACTION = Object.freeze({
  MERGE: 'merge',
  RETIRE: 'retire',
  SPLIT: 'split',
});

export interface AuditProposal {
  action: string;
  target: string;
  // The rules this is about, exactly as they read in the file today.
  rules: string[];
  // What to put in their place. Empty for a retire.
  replacement: string[];
  why: string;
}

// One rule as it sits in a file, with enough to find it again.
export interface RuleRef {
  target: string;
  section: string;
  text: string;
}

function sectionOf(text: string, heading: string): string {
  const idx = text.indexOf(heading);
  if (idx === -1) return '';
  const start = idx + heading.length;
  const next = text.indexOf('\n## ', start);
  return text.slice(start, next === -1 ? text.length : next);
}

// The [start, end) LINE range one section covers, or null if it is not there.
// applyAudit edits inside this and nowhere else.
function sectionRange(doc: string, heading: string): { start: number; end: number } | null {
  const lines = doc.split('\n');
  const start = lines.findIndex((line) => line.trimEnd() === heading);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]!.startsWith('## ')) {
      end = i;
      break;
    }
  }
  return { start: start + 1, end };
}

function bulletsOf(body: string): string[] {
  return body
    .split('\n')
    .map((line) => line.match(/^- (.+)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => m[1]!.trim())
    .filter(Boolean);
}

// Every rule currently in force. `## Proposed` is left out on purpose: those
// are guesses nobody has ruled on, and auditing a guess is wasted money.
export function rulesInForce(repoRoot: string): RuleRef[] {
  const rules: RuleRef[] = [];
  for (const category of loadCategories(repoRoot)) {
    const target = targetOf(category);
    const filePath = ethosPath(repoRoot, target);
    if (!fs.existsSync(filePath)) continue;
    const doc = readDoc(filePath);
    for (const heading of [AUTHORED_HEADING, LEARNED_HEADING]) {
      for (const text of bulletsOf(sectionOf(doc, heading))) {
        rules.push({ target, section: heading, text });
      }
    }
  }
  return rules;
}

// Any run of path-shaped characters holding at least one slash.
const PATH_TOKEN_RE = /[\w.@-]+(?:\/[\w.@-]+)+\/?/g;
// A URL is not a repository path, and its own slashes look exactly like one.
const URL_RE = /\bhttps?:\/\/\S+/gi;
const FILE_EXTENSION_RE = /\.[a-z0-9]{1,5}$/i;

// The real top-level entries of the repo: "src", "bin", "docs", "package.json".
function topLevelNames(files: string[]): Set<string> {
  return new Set(files.map((file) => file.split('/')[0]!));
}

// A path claim, not English. "src/gone" is one because src/ is real;
// "legacy/old.js" is one because of the extension; "CI/CD" is neither.
function isPathClaim(token: string, roots: Set<string>): boolean {
  return roots.has(token.split('/')[0]!) || FILE_EXTENSION_RE.test(token);
}

function isPresent(token: string, files: string[]): boolean {
  return files.some(
    (file) =>
      file === token ||
      file.startsWith(`${token}/`) ||
      // An ignored directory arrives as "dist/". git never lists what is
      // inside it, but those files are real and rules do name them.
      (file.endsWith('/') && token.startsWith(file)),
  );
}

// Tracked files plus ignored entries. A rule naming .env or dist/ must not
// read as deleted just because git hides those from ls-files.
export function auditFileList(repoRoot: string): string[] {
  try {
    return [...listProjectFiles(repoRoot), ...listIgnoredEntries(repoRoot)];
  } catch {
    // No git, no answer. Empty means "we cannot judge" — deadReferences
    // refuses to report anything rather than calling every path missing.
    return [];
  }
}

// Paths a rule names that are not in the repo. The model has no filesystem,
// so code answers this and hands the answer over.
export function deadReferences(
  rules: RuleRef[],
  files: string[],
): { text: string; missing: string[] }[] {
  // No listing means no evidence. Judging against an empty repo would report
  // EVERY path as missing, under a heading that calls itself checked fact.
  if (files.length === 0) return [];

  const roots = topLevelNames(files);
  const found: { text: string; missing: string[] }[] = [];
  for (const rule of rules) {
    const missing = [
      ...new Set(
        (rule.text.replace(URL_RE, ' ').match(PATH_TOKEN_RE) ?? [])
          // Trailing punctuation and a trailing slash are prose, not the path.
          .map((token) => token.replace(/[.,;:)\]]+$/, '').replace(/\/$/, ''))
          .filter((token) => isPathClaim(token, roots))
          .filter((token) => !isPresent(token, files)),
      ),
    ];
    if (missing.length > 0) found.push({ text: rule.text, missing });
  }
  return found;
}

export function buildAuditPrompt(
  rules: RuleRef[],
  dead: { text: string; missing: string[] }[],
): string {
  const listing = rules
    .map((r, i) => `${String(i + 1).padStart(3)}. [${r.target}] ${r.text}`)
    .join('\n');

  // Checked against the repo, not guessed. The model has no filesystem.
  const deadBlock =
    dead.length === 0
      ? 'Every path named in these rules still exists in the repository.'
      : dead.map((d) => `- ${d.missing.join(', ')}  — named by: ${d.text}`).join('\n');

  return `You are auditing a project's own rules. These are read by every agent
that works on this codebase, so a redundant one costs money on every ticket
and a contradictory one causes real mistakes.

## The rules in force
${listing}

## Paths checked against the repository (fact, not opinion)
${deadBlock}

## What to propose
- MERGE two or more rules that say the same thing in different words. Give
  the single wording that keeps every distinct point they made between them.
- RETIRE a rule that contradicts another, or that is anchored to a path
  listed as missing above. Do not guess that something is gone — the section
  above is the complete evidence, and it is checked, not inferred.
- SPLIT one bullet that is really two rules, so each can be scoped or
  retired on its own.

## What NOT to propose
- Rewording for style. A rule that reads awkwardly but says one clear thing
  is fine as it is.
- Merging two rules that overlap but each carry a point the other does not.
  If the merged wording would lose anything, leave them alone.
- Anything about a rule you do not understand. Say nothing instead.

Proposing nothing is a correct and common answer.

## Output
One JSON array, nothing else. No prose before or after it.

[
  {
    "action": "merge" | "retire" | "split",
    "rules": ["<the rule text, copied EXACTLY as it appears above>"],
    "replacement": ["<new wording>"],
    "why": "<one line>"
  }
]

Copy rule text exactly, character for character. A rule that does not match
one above is dropped, because it cannot be found in the file. "replacement"
is empty for a retire.`;
}

// Reads the model's answer. Anything unreadable is dropped rather than guessed at — the cost of
// dropping a proposal is one more audit run; the cost of guessing is a wrong edit to a permanent file.
export function parseAuditResponse(raw: string, rules: RuleRef[]): AuditProposal[] {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const byText = new Map(rules.map((r) => [r.text, r]));
  const proposals: AuditProposal[] = [];

  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const action = typeof row.action === 'string' ? row.action : '';
    if (!(Object.values(AUDIT_ACTION) as string[]).includes(action)) continue;

    const named = Array.isArray(row.rules) ? row.rules.filter((r) => typeof r === 'string') : [];
    // Every rule it names must really exist, or we cannot edit the file.
    const found = named.map((text) => byText.get(text as string)).filter(Boolean) as RuleRef[];
    if (found.length !== named.length || found.length === 0) continue;

    // One proposal may not span two files: each file is edited on its own.
    const target = found[0]!.target;
    if (found.some((r) => r.target !== target)) continue;

    const replacement = Array.isArray(row.replacement)
      ? row.replacement.filter((r): r is string => typeof r === 'string' && r.trim() !== '')
      : [];
    // A merge or split that replaces rules with nothing is a retire wearing
    // the wrong name, and would delete a rule the human did not agree to lose.
    if (action !== AUDIT_ACTION.RETIRE && replacement.length === 0) continue;

    proposals.push({
      action,
      target,
      rules: found.map((r) => r.text),
      replacement: action === AUDIT_ACTION.RETIRE ? [] : replacement,
      why: typeof row.why === 'string' ? row.why : '',
    });
  }

  return proposals;
}

// Where proposals wait for a decision. Same shape as `workspace.proposed.json`: one cheap LLM pass
// writes it, and the `--keep` run reads it back rather than paying for the pass again.
export function auditProposalPath(repoRoot: string): string {
  return path.join(repoRoot, 'docs', 'glafka', 'ethos', 'audit.proposed.json');
}

// How many rules may pile up before a compaction pass earns its cost.
export const AUDIT_DUE_THRESHOLD = 15;

// Deliberately under .glafka/, which is git-ignored (install.ts IGNORED_DIRS).
// A tracked counter would land dirty mid-push and conflict on merge.
function auditWatermarkPath(repoRoot: string): string {
  return path.join(repoRoot, '.glafka', 'ethos-audit.json');
}

// 0 when no audit has ever run, which is the honest starting point.
export function readAuditWatermark(repoRoot: string): number {
  const filePath = auditWatermarkPath(repoRoot);
  if (!fs.existsSync(filePath)) return 0;
  try {
    const parsed = JSON.parse(readDoc(filePath)) as { ruleCountAtLastAudit?: unknown };
    return typeof parsed.ruleCountAtLastAudit === 'number' ? parsed.ruleCountAtLastAudit : 0;
  } catch {
    // A mangled file is not worth failing a push over. Worst case is one
    // extra pass.
    return 0;
  }
}

export function writeAuditWatermark(repoRoot: string, count: number): void {
  writeDoc(
    auditWatermarkPath(repoRoot),
    `${JSON.stringify({ ruleCountAtLastAudit: count }, null, 2)}\n`,
  );
}

// Whether the rules have grown far enough to be worth one compaction pass.
// Retiring rules drops the count below the watermark, and a negative "grown"
// is not a number worth printing, so it floors at zero.
export function auditIsDue(repoRoot: string): { due: boolean; count: number; grown: number } {
  const count = rulesInForce(repoRoot).length;
  const grown = Math.max(0, count - readAuditWatermark(repoRoot));
  return { due: grown >= AUDIT_DUE_THRESHOLD, count, grown };
}

export function writeAuditProposals(repoRoot: string, proposals: AuditProposal[]): void {
  writeDoc(auditProposalPath(repoRoot), `${JSON.stringify(proposals, null, 2)}\n`);
}

export function readAuditProposals(repoRoot: string): AuditProposal[] {
  const filePath = auditProposalPath(repoRoot);
  if (!fs.existsSync(filePath)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readDoc(filePath));
  } catch {
    // A hand-mangled file is not worth crashing over. The audit is cheap to
    // run again, and refusing here would block the ethos flow entirely.
    return [];
  }
  return Array.isArray(parsed) ? (parsed as AuditProposal[]) : [];
}

export function clearAuditProposals(repoRoot: string): void {
  const filePath = auditProposalPath(repoRoot);
  if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true });
}

export function formatAuditListing(proposals: AuditProposal[]): string {
  return proposals
    .map((p, i) => {
      const head = `  ${i + 1}. ${p.action.toUpperCase()}  [${p.target}]  ${p.why}`;
      const from = p.rules.map((r) => `       - ${r}`).join('\n');
      const to = p.replacement.map((r) => `       + ${r}`).join('\n');
      return [head, from, to].filter(Boolean).join('\n');
    })
    .join('\n\n');
}

// Applies the chosen proposals. Numbers start at 1, like every other --keep. `## Authored` is never
// touched. Those are rules a person wrote by hand, and an LLM does not get to edit them — a proposal about one is reported and skipped.
export function applyAudit(
  repoRoot: string,
  proposals: AuditProposal[],
  keepIndexes: number[],
): { applied: AuditProposal[]; skippedAuthored: AuditProposal[] } {
  const keep = new Set(keepIndexes);
  const chosen = proposals.filter((_, i) => keep.has(i + 1));

  const inForce = rulesInForce(repoRoot);
  // ALL the sections a text appears in, not one. A Map keyed on text can only remember the last section
  // it saw — and a rule present in both Authored and Learned is exactly the case that matters, because the Authored copy is the one that must never be touched.
  const sectionsOfRule = new Map<string, Set<string>>();
  for (const rule of inForce) {
    const key = `${rule.target} ${rule.text}`;
    if (!sectionsOfRule.has(key)) sectionsOfRule.set(key, new Set());
    sectionsOfRule.get(key)!.add(rule.section);
  }

  const applied: AuditProposal[] = [];
  const skippedAuthored: AuditProposal[] = [];

  for (const proposal of chosen) {
    const sections = proposal.rules.flatMap((text) => [
      ...(sectionsOfRule.get(`${proposal.target} ${text}`) ?? []),
    ]);
    // Any of them being Authored is enough. A person wrote those by hand, and
    // an LLM does not get to edit them.
    if (sections.includes(AUTHORED_HEADING)) {
      skippedAuthored.push(proposal);
      continue;
    }
    // A proposal that spans sections has no single correct place to put its replacement, the same way a
    // cross-file one has no single file. Skipped and reported, not guessed at.
    if (new Set(sections).size !== 1) {
      skippedAuthored.push(proposal);
      continue;
    }
    const section = sections[0]!;

    const filePath = ethosPath(repoRoot, proposal.target);
    if (!fs.existsSync(filePath)) continue;

    // Edit ONLY that section's line range. Scanning the whole file is what
    // deleted the Authored copy of a rule whose text also sat in Learned.
    const doc = readDoc(filePath);
    const range = sectionRange(doc, section);
    if (range === null) continue;

    const lines = doc.split('\n');
    const toRemove = new Set(proposal.rules);
    const out: string[] = [];
    let replaced = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const inSection = i >= range.start && i < range.end;
      const bullet = inSection ? line.match(/^- (.+)$/) : null;
      if (!bullet || !toRemove.has(bullet[1]!.trim())) {
        out.push(line);
        continue;
      }
      // The replacement lands where the first removed rule was, so the file
      // keeps its order instead of growing a pile at the end.
      if (!replaced) {
        for (const text of proposal.replacement) out.push(`- ${text}`);
        replaced = true;
      }
    }

    // A retire is the only action that removes a rule and puts nothing in its
    // place, so it is the only one that needs an undo.
    const rewritten = out.join('\n');
    // A rule can be retired, moved back up by hand, then retired again.
    // Writing it twice would grow Dropped every time round that loop.
    const alreadyDropped = new Set(bulletsOf(sectionOf(rewritten, DROPPED_HEADING)));
    const toDrop = proposal.rules.filter((text) => !alreadyDropped.has(text));
    const withDropped =
      proposal.action === AUDIT_ACTION.RETIRE && toDrop.length > 0
        ? appendToSection(rewritten, DROPPED_HEADING, toDrop.map((text) => `- ${text}`).join('\n'))
        : rewritten;

    writeDoc(filePath, withDropped.replace(/\n{3,}/g, '\n\n'));
    applied.push(proposal);
  }

  return { applied, skippedAuthored };
}

// Guard, so `--compact` cannot be answered by the same run that proposed.
export function assertAuditDecidable(proposals: AuditProposal[], keep: string | null): void {
  if (proposals.length === 0 || keep !== null) return;
  throw new Error(
    `${proposals.length} compaction proposal(s) awaiting your decision — these edit permanent ` +
      `project rules, so nothing is applied until you say so:\n` +
      `${formatAuditListing(proposals)}\n\n` +
      `  glafka odysse --compact --keep all     apply all of them\n` +
      `  glafka odysse --compact --keep 1,3     apply only those\n` +
      `  glafka odysse --compact --keep none    discard all of them`,
  );
}

export { PROPOSED_HEADING };
