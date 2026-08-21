// Flow-overrules-defaults rule, pinned across the shipped surface (CGLAB-73).
//
// A step's exitCriteria is the project's configuration; the master skill, the
// /agenfk-* commands and the per-client rule bundles are defaults. Agents hit a
// hard contradiction when a REVIEW step demands an independent adversarial
// reviewer while Standard Mode forbids sub-agents — and the observed failure was
// the agent stalling to ask, or quietly substituting a self-review, which cannot
// satisfy that criterion at all because it shares the author's blind spots.
//
// Every file asserted here is INSTALLED onto user machines by scripts/install.mjs,
// so a rule that lives in only some of them is a rule that half the fleet never
// sees. These tests exist to fail when a bundle drifts.

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../../..');

/** The per-client bundles the installer copies into each AI client's config dir. */
const RULE_BUNDLES = [
  'clauderules/CLAUDE.md',
  'codexrules/AGENTS.md',
  'geminirules/GEMINI.md',
  'cursorrules/agenfk.mdc',
];

/** Everything that has to carry the precedence rule, bundles plus the skill surface. */
const ALL_SURFACES = [...RULE_BUNDLES, 'SKILL.md', 'SDLC.md'];

const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('flow exit criteria overrule the shipped defaults', () => {
  for (const rel of ALL_SURFACES) {
    it(`${rel} states that exit criteria win over the shipped instructions`, () => {
      const src = read(rel);
      expect(src).toMatch(/exit\s+criteria/i);
      // The precedence claim itself, not merely a mention of exit criteria.
      expect(src).toMatch(/overrul|outrank|take precedence|precedence|wins?\b/i);
    });

    it(`${rel} tells the agent to record the override in its evidence`, () => {
      // Without this the override is indistinguishable from an agent ignoring
      // the rules, and the audit trail is what makes it reviewable.
      expect(read(rel)).toMatch(/evidence/i);
    });
  }
});

describe('the review exemption is spelled out, not left to inference', () => {
  const SURFACES = [...ALL_SURFACES, 'commands/agenfk.md', 'commands/agenfk-review.md'];

  for (const rel of SURFACES) {
    it(`${rel} says a review step may spawn an agent despite Standard Mode`, () => {
      const src = read(rel);
      expect(src).toMatch(/sub-?agent|separate (review )?agent|independent.{0,30}review|adversarial/i);
      expect(src).toMatch(/review/i);
    });
  }

  // The reasoning has to travel with the rule. An agent that knows only "spawn a
  // reviewer" will skip it under time pressure; one that knows a self-review
  // cannot satisfy the criterion will not.
  for (const rel of [...RULE_BUNDLES, 'SKILL.md', 'SDLC.md', 'commands/agenfk-review.md']) {
    it(`${rel} explains that a self-review shares the author's blind spots`, () => {
      expect(read(rel)).toMatch(/blind spot|independence is the|wrote it(self)?|author'?s?\b/i);
    });
  }
});

describe('the exemption does not become a licence', () => {
  // The flow can direct HOW work happens; it must not be readable as permission
  // to skip gatekeeper, forge evidence, or write state behind the server's back.
  for (const rel of [...RULE_BUNDLES, 'SKILL.md', 'SDLC.md']) {
    it(`${rel} carves out the framework's integrity rules`, () => {
      const src = read(rel);
      expect(src).toMatch(/gatekeeper/i);
      expect(src).toMatch(/fabricat|forge/i);
    });

    it(`${rel} calls a step that demands an integrity breach a flow bug`, () => {
      expect(read(rel)).toMatch(/flow bug/i);
    });
  }
});

describe('reviewers are briefed as read-only', () => {
  // A reviewer that edits a shared checkout can leave a defect behind — this
  // actually happened while the rule was being written (a mutation probe left an
  // `OR 1=1` predicate in a tenant-scoped query).
  for (const rel of [...RULE_BUNDLES, 'commands/agenfk-review.md']) {
    it(`${rel} tells reviewers not to modify the working tree`, () => {
      expect(read(rel)).toMatch(/read-only|do not (modify|edit)/i);
    });
  }

  for (const rel of [...RULE_BUNDLES, 'SKILL.md', 'commands/agenfk-review.md']) {
    it(`${rel} requires verifying findings before acting on them`, () => {
      const src = read(rel);
      expect(src).toMatch(/verify (each|every)|verify.{0,30}finding/i);
      expect(src).toMatch(/false positive/i);
    });
  }
});

describe('clients without a sub-agent facility still get a review', () => {
  // Cursor has no sub-agent system, so a rule phrased only as "spawn an agent"
  // silently degrades to no review at all there.
  for (const rel of [...RULE_BUNDLES, 'SKILL.md', 'commands/agenfk-review.md']) {
    it(`${rel} offers a fresh-context fallback`, () => {
      expect(read(rel)).toMatch(/fresh (context|session)/i);
    });
  }
});
