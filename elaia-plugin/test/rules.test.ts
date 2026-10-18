import { describe, expect, it } from 'vitest';
import { GLAFKA_INFO } from '../src/info';
import { blockedBy } from './support/claudeRules';

// The block rules this plugin gives Elaia, checked the way Claude Code matches them.
const T1 = '2026-10-13-add-csv-export';
const T2 = '2026-10-13-add-csv-export-v2';
const { blocked } = GLAFKA_INFO;
const otherTicket = (id: string) => blocked.otherTicket.map((t) => t.split('{id}').join(id));

describe('another ticket stays out of reach, however glafka is written', () => {
  it.each([
    `glafka cancel --force ${T2}`,
    `glafka poreia ${T2}`,
    `glafka cancel "${T2}"`,
    `glafka cancel '${T2}' --force`,
    `node .glafka/bin/glafka.js lysis ${T2} --force`,
    `/usr/local/bin/glafka cancel ${T2}`,
  ])('blocks %s', (command) => {
    expect(blockedBy(otherTicket(T2), command)).toBe(true);
  });

  it('does not catch a ticket whose id only starts the same', () => {
    expect(blockedBy(otherTicket(T1), `glafka vima ${T2}`)).toBe(false);
  });
});

describe('planning, pushing and every-ticket commands', () => {
  it.each(['env glafka plan T1 p.md', '/usr/local/bin/glafka ergon T1', 'npx glafka heureka x'])(
    'keeps %s for the Start button',
    (command) => {
      expect(blockedBy(blocked.planning, command)).toBe(true);
    },
  );

  it('keeps every spelling of epistle for the Push button', () => {
    expect(blockedBy(blocked.pushing, 'node .glafka/bin/glafka.js epistle T1')).toBe(true);
  });

  it.each([
    'glafka vima --all',
    'glafka vima --all --restart',
    `glafka lysis ${T1} --sweep`,
    'glafka guardrails --level 2',
    'glafka guardrails --install-hook',
    'glafka odysse --keep all',
    'glafka odysse --workspace-keep all',
    'glafka install',
    'glafka install claude',
  ])('keeps %s in the main chat', (command) => {
    expect(blockedBy(blocked.shared, command)).toBe(true);
  });

  it('lets a plain step run: "plan first" is not a plan command', () => {
    expect(blockedBy(blocked.planning, 'echo plan first')).toBe(false);
  });
});
