/**
 * The rule bundles spell out `agenfk update`'s flags verbatim, so a new flag that
 * isn't added there is invisible to every agent that reads them — which is the
 * whole point of the bundles. `agenfk update --parent` (re-parent an item, or
 * detach it with `none`) must be documented everywhere the command surface is.
 *
 * Same shape as pr-registration-rule-docs.test.ts.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../../..');

// Every bundle that documents the `agenfk update` flag list.
const DOCS = [
  'clauderules/CLAUDE.md',
  'codexrules/AGENTS.md',
  'geminirules/GEMINI.md',
  'cursorrules/agenfk.mdc',
  'SKILL.md',
];

describe('re-parenting is documented in the rule bundles', () => {
  for (const rel of DOCS) {
    it(`${rel} documents --parent on agenfk update`, () => {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      expect(src).toMatch(/--parent/);
    });

    it(`${rel} explains how to detach an item to top level`, () => {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      // The detach form is the non-obvious half — a bare --parent with no value
      // is not how you unparent.
      expect(src).toMatch(/--parent\s+none/);
    });
  }
});
