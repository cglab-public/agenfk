/**
 * The per-client rule bundles must describe the SAME command surface.
 *
 * The installer copies one bundle per client — clauderules/CLAUDE.md,
 * codexrules/AGENTS.md, geminirules/GEMINI.md, cursorrules/agenfk.mdc — and
 * each is the entire contract its agent reads. They are maintained by hand, so
 * they drift: a flag added to the table an author happens to have open is
 * invisible to every other client, and the agent there simply never uses it.
 *
 * That is not hypothetical. When this test was written, `agenfk list --active`
 * was documented only for Claude, while the initialization procedure in ALL
 * FOUR bundles instructs the agent to run `--active` to keep its context small.
 * Codex, Gemini and Cursor agents were being told to use a flag their own
 * command reference did not list.
 *
 * This pins the invariant rather than the prose: whatever the tables say, they
 * must say the same thing everywhere. It deliberately does NOT assert that any
 * particular feature is mentioned — a test that greps docs for a phrase pins
 * nothing and rots immediately.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../../..');

const BUNDLES: Record<string, string> = {
  'clauderules/CLAUDE.md': 'Claude Code',
  'codexrules/AGENTS.md': 'Codex',
  'geminirules/GEMINI.md': 'Gemini',
  'cursorrules/agenfk.mdc': 'Cursor',
};

/**
 * Pull the `agenfk …` invocations out of a bundle's command-reference tables.
 * Keyed by the row label so a mismatch names the row that drifted, not an
 * anonymous string difference.
 */
function commandRows(file: string): Map<string, string> {
  const text = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
  const rows = new Map<string, string>();
  for (const line of text.split('\n')) {
    const m = line.match(/^\|\s*([^|]+?)\s*\|/);
    if (!m) continue;
    // ALL backticked invocations on the row, not just the first: several rows
    // list more than one (`agenfk skills install … · agenfk skills uninstall …`)
    // and comparing only the first hid drift in the rest.
    const invocations = [...line.matchAll(/`(agenfk [^`]+)`/g)].map(x => x[1].replace(/\s+/g, ' ').trim());
    if (invocations.length) rows.set(m[1], invocations.join(' · '));
  }
  return rows;
}

/** Long-form flags, including ones carrying digits or capitals — the previous
 *  /--[a-z][a-z-]*​/ silently ignored those. */
const FLAG_PATTERN = /--[A-Za-z][A-Za-z0-9-]*/g;

/** A row may document several commands, joined by ' · '. */
const invocationsOf = (row: string): string[] => row.split(' · ');

/** 'agenfk flow show …' -> 'flow show' is not needed; the first word after
 *  'agenfk' is what the option lookup keys on. */
const commandNameOf = (invocation: string): string => invocation.split(/\s+/)[1] ?? '';

describe('per-client rule bundle parity', () => {
  const files = Object.keys(BUNDLES);

  it.each(files)('%s exposes a command reference table', (file) => {
    expect(commandRows(file).size).toBeGreaterThan(20);
  });

  it('every bundle documents the same set of commands', () => {
    const reference = commandRows(files[0]);
    for (const file of files.slice(1)) {
      const rows = commandRows(file);
      const missing = [...reference.keys()].filter(k => !rows.has(k));
      const extra = [...rows.keys()].filter(k => !reference.has(k));
      expect({ file, missing, extra }).toEqual({ file, missing: [], extra: [] });
    }
  });

  it('every bundle documents each command with the same flags', () => {
    const reference = commandRows(files[0]);
    for (const file of files.slice(1)) {
      const rows = commandRows(file);
      for (const [label, invocation] of reference) {
        expect(`${file} :: ${label} :: ${rows.get(label)}`).toBe(`${file} :: ${label} :: ${invocation}`);
      }
    }
  });

  it('documents every user-facing flag the CLI implements on create/update', async () => {
    // The reverse direction of the check below, and the one that makes this
    // file able to fail when a shipped capability is left out of the agent
    // instructions — which is the whole point of the bundles. Anchored to the
    // real commander definitions, so it is not a grep for a phrase: add a flag
    // to the CLI and every bundle must document it or this fails.
    const { program } = await import('../index');
    const flagsOf = (name: string) =>
      ((program.commands.find(c => c.name() === name) as any)?.options ?? [])
        .map((o: any) => o.long)
        .filter(Boolean);

    for (const file of files) {
      const rows = [...commandRows(file).values()];
      for (const command of ['create', 'update']) {
        // Only the rows that actually document THIS command. Joining every row
        // meant documenting --jira-item on the `list` row would have passed.
        const documented = rows.filter(r => invocationsOf(r).some(i => commandNameOf(i) === command)).join(' ');
        for (const flag of flagsOf(command)) {
          expect({ file, command, flag, documented: documented.includes(flag) })
            .toEqual({ file, command, flag, documented: true });
        }
      }
    }
  });

  it('documents no flag on create/update that the CLI does not actually implement', async () => {
    // Ties the tables to the real command surface: a documented flag that does
    // not exist sends every agent down a path that errors out.
    const { program } = await import('../index');
    const realFlags = (name: string) =>
      new Set(
        ((program.commands.find(c => c.name() === name) as any)?.options ?? [])
          .map((o: any) => o.long)
          .filter(Boolean),
      );

    for (const file of files) {
      const rows = commandRows(file);
      for (const [label, invocation] of rows) {
        // Per invocation, not per row: a row may join several commands with
        // '·', and scanning the whole joined string attributed one command's
        // flags to another.
        for (const single of invocationsOf(invocation)) {
          const commandName = commandNameOf(single);
          if (commandName !== 'create' && commandName !== 'update') continue;
          const documented = single.match(FLAG_PATTERN) ?? [];
          const actual = realFlags(commandName);
          const bogus = documented.filter(f => !actual.has(f));
          expect({ file, label, bogus }).toEqual({ file, label, bogus: [] });
        }
      }
    }
  });
});
