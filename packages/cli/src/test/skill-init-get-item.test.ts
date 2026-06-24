/**
 * Content regression test: the entry-point `agenfk` skill must tell the agent
 * how to fetch a SPECIFIC item by id during Initialization.
 *
 * Root cause of the bug this guards: the standard-mode skill's Initialization
 * only covered "resume the IN_PROGRESS task" and "create a new one" — there was
 * no branch for "the user named item <id>, go load it". With no `agenfk get
 * <id> --json` instruction, weaker models (e.g. GLM 5.2 on pi.dev) improvised a
 * native `read` of a fabricated `<id>.json` filename, producing a tool-call
 * validation error instead of using the CLI.
 *
 * Contract: the entry-point skill flavors (commands/agenfk.md + master SKILL.md)
 * must instruct `agenfk get <id> --json` so any model is steered to the CLI.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '../../../..');

// The entry-point standard-mode skill flavors a user invokes with "/agenfk".
const entryPointSkills = [
  path.join(root, 'commands', 'agenfk.md'),
  path.join(root, 'SKILL.md'),
];

const GET_ITEM_RE = /agenfk\s+get\s+<\w[\w-]*>\s+--json/;

describe('entry-point agenfk skill instructs fetching a specific item by id', () => {
  it.each(entryPointSkills.map(f => [path.relative(root, f), f] as const))(
    '%s contains an `agenfk get <id> --json` instruction',
    (_rel, file) => {
      const content = readFileSync(file, 'utf8');
      expect(content).toMatch(GET_ITEM_RE);
    }
  );

  it('commands/agenfk.md handles a referenced item id within its Initialization section', () => {
    const content = readFileSync(path.join(root, 'commands', 'agenfk.md'), 'utf8');
    const initIdx = content.indexOf('## Initialization');
    expect(initIdx).toBeGreaterThan(-1);
    // The Initialization section (to end of file) must mention fetching by id.
    const initSection = content.slice(initIdx);
    expect(initSection).toMatch(GET_ITEM_RE);
  });
});
