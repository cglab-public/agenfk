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

describe('PR model-discovery guidance (harness that cannot introspect its model)', () => {
  // Weaker harnesses (e.g. pi/GLM) reported --harness correctly but failed --model.
  // The instruction must tell agents to DERIVE the model from the harness config or
  // current session log rather than omit/guess it.
  const FILES = [...DOCS, 'commands/agenfk-pr.md'];
  for (const rel of FILES) {
    it(`${rel} tells agents to derive the model from session log / harness config`, () => {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      // Must reference both the model and a derivation source (session log or config).
      expect(src).toMatch(/session log/i);
      expect(src).toMatch(/config(uration)?/i);
      // And tie it to determining the model when it can't be stated directly.
      expect(src).toMatch(/can(not|'t)\s+(identify|state|determine).{0,40}model|determine your model|figure out.{0,20}model/i);
    });
  }
});

describe('PR model reporting resists example-parroting', () => {
  // pi/GLM copied the literal "claude-opus-4-8" example instead of its own model.
  // The pi-facing skill must explicitly tell agents not to copy the example and
  // to report their own model.
  it('commands/agenfk-pr.md tells agents not to copy the example model id', () => {
    const src = fs.readFileSync(path.join(ROOT, 'commands/agenfk-pr.md'), 'utf8');
    expect(src).toMatch(/do not copy|don'?t copy|never copy|not.{0,15}copy/i);
    expect(src).toMatch(/your (own |actual )?model/i);
  });
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
