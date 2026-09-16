/**
 * The shipped rule bundles must agree with each other (90fd9d32).
 *
 * Four files reach a user's machine and are supposed to say the same thing:
 * SKILL.md, clauderules/CLAUDE.md, codexrules/AGENTS.md and
 * cursorrules/agenfk.mdc. The repo's own CLAUDE.md warns about exactly this
 * ("keep clauderules/CLAUDE.md in sync with SKILL.md/SDLC.md") and nothing
 * enforced it, so the warning was the only thing standing between a rule and
 * three clients that never received it.
 *
 * THE FAILURE THIS CATCHES IS DRIFT, NOT ABSENCE. A test that asserts a magic
 * string exists in one file is worth very little: it passes the moment somebody
 * pastes the string, and it says nothing about the other three. What actually
 * happens - and happened this week - is that a rule is added where the author
 * was looking and forgotten everywhere else. So every rule below is checked
 * across the whole set, and a bundle that has it while another does not is the
 * failure.
 *
 * Both rules here exist because several agents share ONE worktree. See
 * MULTI_AGENT.md; in that world staging is the only signal of who touched what,
 * and a claim is the only thing that stops two agents owning one file.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO = path.resolve(__dirname, '../../../..');

/** Everything the installer copies onto a user's machine. */
const BUNDLES = [
  'SKILL.md',
  'clauderules/CLAUDE.md',
  'codexrules/AGENTS.md',
  'cursorrules/agenfk.mdc',
] as const;

const read = (rel: string): string => fs.readFileSync(path.join(REPO, rel), 'utf8');

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
  const contents = new Map(BUNDLES.map(b => [b, read(b)]));

  it('ships all four bundles, so the list itself cannot rot silently', () => {
    // If a bundle is renamed or dropped, this file must be updated with it -
    // otherwise the parity check below quietly stops covering a client.
    for (const b of BUNDLES) {
      expect(fs.existsSync(path.join(REPO, b)), `${b} is missing`).toBe(true);
    }
  });

  for (const rule of RULES) {
    it(`agrees on: ${rule.name}`, () => {
      /*
       * Reported as a SET rather than one assertion per file, so a run names
       * every bundle that is behind. Fixing them one red at a time is how a
       * rule ends up in two of four.
       */
      const missing = BUNDLES.filter(b => !carries(contents.get(b)!, rule.needles));
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
  const contents = BUNDLES.map(b => ({ b, text: read(b) }));

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
