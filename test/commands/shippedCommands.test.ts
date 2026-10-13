import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const COMMANDS_DIR = path.join(REPO_ROOT, 'installKit', '.claude', 'commands', 'glafka');

function commandFiles(): { name: string; frontmatter: string[] }[] {
  return fs
    .readdirSync(COMMANDS_DIR)
    .filter((name) => name.endsWith('.md'))
    .map((name) => {
      const text = fs.readFileSync(path.join(COMMANDS_DIR, name), 'utf8');
      const match = text.match(/^---\n([\s\S]*?)\n---/);
      assert.ok(match, `${name}: no frontmatter block`);
      return { name, frontmatter: match![1]!.split('\n') };
    });
}

function valueOf(frontmatter: string[], key: string): string | null {
  const line = frontmatter.find((l) => l.startsWith(`${key}:`));
  return line === undefined ? null : line.slice(key.length + 1).trim();
}

// An unquoted `[` or `{` opens a YAML flow collection, so the value parses as
// a list or a map rather than a string. `argument-hint: [a | b]` did exactly
// that: the command failed validation and the host skipped it in silence — it
// simply did not exist, with no error to notice. Quoting is the whole fix.
const OPENS_A_COLLECTION = /^[[{]/;

test('every argument-hint is a string, not a list or a map', () => {
  for (const { name, frontmatter } of commandFiles()) {
    const hint = valueOf(frontmatter, 'argument-hint');
    if (hint === null) continue;
    assert.equal(
      OPENS_A_COLLECTION.test(hint),
      false,
      `${name}: argument-hint starts with ${hint[0]}, so YAML reads it as a collection — wrap it in quotes`,
    );
  }
});

test('every shipped command names itself and points at its skill', () => {
  for (const { name, frontmatter } of commandFiles()) {
    const description = valueOf(frontmatter, 'description');
    assert.ok(description, `${name}: missing a description`);
    assert.equal(
      OPENS_A_COLLECTION.test(description!),
      false,
      `${name}: description reads as a collection — wrap it in quotes`,
    );

    const body = fs.readFileSync(path.join(COMMANDS_DIR, name), 'utf8');
    const skill = `docs/glafka/skills/${name}`;
    assert.ok(body.includes(skill), `${name}: does not point at ${skill}`);
  }
});

// A slash command is only reachable if its skill doc ships beside it.
test('every shipped command has the skill doc it points at', () => {
  const skillsDir = path.join(REPO_ROOT, 'installKit', 'skills');
  for (const { name } of commandFiles()) {
    assert.ok(
      fs.existsSync(path.join(skillsDir, name)),
      `${name}: no matching installKit/skills/${name}`,
    );
  }
});
