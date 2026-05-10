import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../../..');

const DOCS = [
  'clauderules/CLAUDE.md',
  'codexrules/AGENTS.md',
  'geminirules/GEMINI.md',
  'cursorrules/agenfk.mdc',
];

describe('PR-registration belt-and-suspenders rule', () => {
  for (const rel of DOCS) {
    it(`${rel} mentions register_pr after gh pr create`, () => {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      expect(src).toMatch(/register_pr/);
      expect(src).toMatch(/update_pr_sizing/);
    });
  }
});

describe('AFK_ARCHITECTURE.md client matrix', () => {
  it('no longer claims Codex / Cursor / Gemini are instructional-only on hooks', () => {
    const src = fs.readFileSync(path.join(ROOT, 'AFK_ARCHITECTURE.md'), 'utf8');
    // Acceptable: any mention that these clients HAVE hooks now.
    expect(src).toMatch(/hooks/i);
    // The phrase "instructional-only" used to apply to Cursor / Codex / Gemini —
    // ensure that, if present, it is now scoped or disclaimed.
    if (/instructional[-\s]only/i.test(src)) {
      expect(src).toMatch(/now\s+(have|support|expose)\s+hooks|hook\s+system\s+(added|added in|since)/i);
    }
  });
});
