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

/**
 * The RULE half of bundle parity (90fd9d32).
 *
 * The suite above pins the command surface. This half pins the RULES that exist
 * because several agents share ONE worktree: staging is the only signal of who
 * touched what, and a claim is the only thing that stops two agents owning one
 * file. It checks each rule across the whole set, so a bundle that carries it
 * while another does not is the failure - the shape drift actually takes.
 */
/** Everything the installer copies onto a user's machine (the RULES half). */
const RULE_BUNDLES = [
  'SKILL.md',
  'clauderules/CLAUDE.md',
  'codexrules/AGENTS.md',
  'cursorrules/agenfk.mdc',
] as const;

const read = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

/**
 * A rule, described by several spellings rather than one.
 *
 * Matching a single sentence would make this a test of phrasing: reword the
 * rule in one bundle to suit that client's voice and it goes red for no reason.
 * Each entry lists the load-bearing ideas, and a bundle carries the rule when
 * it carries all of them.
 */
const RULES = [
  {
    name: 'stage only what this card changed',
    needles: [/add\s+-A/i, /stage/i],
  },
  {
    name: 'declare the files this card owns',
    needles: [/\bclaims?\b/i, /agenfk\s+update[^\n]*--claims|claims\s*\[|"claims"/i],
  },
  {
    /*
     * The two rules about a supervisor GUESSING (CGLAB-204), and they are
     * checked as one because they fail together: both are what an agent does
     * when it has no news and decides anyway.
     */
    name: 'absence authorises nothing, and a failed launch is not relaunched',
    needles: [/absence/i, /authoris|authoriz/i, /relaunch|launch again/i],
  },
] as const;

const carries = (text: string, needles: readonly RegExp[]): boolean =>
  needles.every(n => n.test(text));

describe('every shipped bundle carries every rule', () => {
  const contents = new Map(RULE_BUNDLES.map(b => [b, read(b)]));

  it('ships all four bundles, so the list itself cannot rot silently', () => {
    // If a bundle is renamed or dropped, this file must be updated with it -
    // otherwise the parity check below quietly stops covering a client.
    for (const b of RULE_BUNDLES) {
      expect(fs.existsSync(path.join(REPO_ROOT, b)), `${b} is missing`).toBe(true);
    }
  });

  for (const rule of RULES) {
    it(`agrees on: ${rule.name}`, () => {
      /*
       * Reported as a SET rather than one assertion per file, so a run names
       * every bundle that is behind. Fixing them one red at a time is how a
       * rule ends up in two of four.
       */
      const missing = RULE_BUNDLES.filter(b => !carries(contents.get(b)!, rule.needles));
      expect(
        missing,
        `these bundles do not carry "${rule.name}": ${missing.join(', ')}. `
        + 'All four reach a user machine and must say the same thing.',
      ).toEqual([]);
    });
  }
});

/**
 * What the claims rule has to actually say.
 *
 * The parity test above would pass on four files that each mention claims in
 * passing. These pin the two halves an agent cannot work without: the command
 * that declares them, and what happens when somebody else already holds the
 * path.
 */
describe('the claims rule is usable, not just present', () => {
  const contents = RULE_BUNDLES.map(b => ({ b, text: read(b) }));

  it('tells an agent how to declare, not only that claims exist', () => {
    for (const { b, text } of contents) {
      expect(
        /--claims|"claims"|claims\s*\[/.test(text),
        `${b} mentions claims without showing how to set them`,
      ).toBe(true);
    }
  });

  it('says what a claim may be, since a glob is refused', () => {
    // The server returns 400 on a glob. A rule that does not say so produces an
    // agent that learns it from an error, once per agent, forever.
    for (const { b, text } of contents) {
      expect(
        /glob/i.test(text),
        `${b} does not warn that globs are refused`,
      ).toBe(true);
    }
  });

  it('says a conflict is refused, and by whom', () => {
    // Without this the refusal reads as a bug. With it, it reads as the
    // mechanism working, and the agent knows to ask the holder.
    for (const { b, text } of contents) {
      expect(
        /refus|conflict|409/i.test(text),
        `${b} does not say a claimed path is refused`,
      ).toBe(true);
    }
  });
});

/**
 * NO MERGE-CONFLICT MARKER EVER SHIPS.
 *
 * A diff3 base marker (`||||||| <sha>`) survived a merge in three of these
 * bundles, and the installer then wrote it into every user's live config -
 * `~/.claude/CLAUDE.md` is loaded into EVERY Claude Code session, so the junk
 * reached every agent on that machine, not just the one who hit the conflict.
 *
 * Only the BASE marker survived, which is exactly why nobody saw it: the text
 * around it read as a plausible union of both sides, so the file never looked
 * broken. A guard is the only thing that catches that shape.
 */
describe('shipped rule bundles carry no merge-conflict marker', () => {
  // `|` is table syntax and `=` can be a setext underline, so these require the
  // diff3 shapes specifically: seven of a kind, then a space or end of line.
  const MARKERS: RegExp[] = [/^<{7}(?: |$)/, /^\|{7}(?: |$)/, /^={7}$/, /^>{7}(?: |$)/];
  for (const file of Object.keys(BUNDLES)) {
    it(`${file} is clean`, () => {
      const text = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
      const bad = text.split('\n').filter(l => MARKERS.some(re => re.test(l)));
      expect(bad, `merge-conflict marker(s) in ${file}: ${bad.join(' | ')}`).toEqual([]);
    });
  }
});
