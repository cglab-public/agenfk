/**
 * @file CGLAB-457 (T2) — /agenfk-review keeps the reviewer and the author apart.
 *
 * The command used to brief the review agent to finish with `agenfk verify`.
 * The server reads a reviewer that ran verify as an AUTHOR (it advanced the
 * card), so a sub-agent that followed the command voided its own review. The
 * command now has two halves: what the reviewer does (from the server's brief,
 * read-only, never advancing anything) and what the author does with the
 * findings (record the review, then verify).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const doc = fs.readFileSync(path.join(REPO_ROOT, 'commands', 'agenfk-review.md'), 'utf8');

/** The text under a `## ` heading, up to the next one. */
function section(title: RegExp): string {
  const parts = doc.split(/^## /m).slice(1);
  const hit = parts.find(p => title.test(p.split('\n')[0]));
  expect(hit, `a "## " section matching ${title}`).toBeDefined();
  return hit!;
}

describe('commands/agenfk-review.md', () => {
  it("the reviewer's half starts from the server's brief and never advances a card", () => {
    const reviewer = section(/reviewer/i);
    expect(reviewer).toContain('agenfk review brief');
    expect(reviewer).not.toMatch(/agenfk verify\b/);
    expect(reviewer).not.toMatch(/agenfk update[^\n]*--status/);
    expect(reviewer).not.toContain('agenfk review record');
  });

  it("the author's half records the review before it verifies", () => {
    const author = section(/author/i);
    const recordAt = author.indexOf('agenfk review record');
    const verifyAt = author.indexOf('agenfk verify');
    expect(recordAt).toBeGreaterThan(-1);
    expect(verifyAt).toBeGreaterThan(recordAt);
  });
});

describe('the rule bundles list the brief', () => {
  for (const file of ['clauderules/CLAUDE.md', 'codexrules/AGENTS.md', 'geminirules/GEMINI.md', 'cursorrules/agenfk.mdc', 'SKILL.md']) {
    it(`${file} names agenfk review brief`, () => {
      expect(fs.readFileSync(path.join(REPO_ROOT, file), 'utf8')).toContain('agenfk review brief');
    });
  }
});
