/**
 * CGLAB-86 — Codex: long-running commands must run as async tasks.
 *
 * Codex's shell tool (exec_command) yields after ~30s by default. AgEnFK's
 * long-running commands — a full test suite (via `agenfk log-test`) and the
 * final-step `agenfk verify` (which runs the project's verifyCommand to land
 * DONE) — routinely exceed that window, so running them synchronously gets
 * the tool call cut off and the completed result is never observed.
 *
 * The shipped Codex rule bundle (codexrules/AGENTS.md) must therefore carry
 * explicit guidance to run those commands as async tasks (exec_command's
 * `yield_time_ms` + waiting on the process for its completed result). This
 * test pins the guidance so a future rewrite of the bundle can't drop it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../../..');
const bundle = readFileSync(path.join(ROOT, 'codexrules', 'AGENTS.md'), 'utf8');

/** Return the body of the section whose heading matches `re` (up to the next heading of same-or-higher level). */
function sectionBody(markdown: string, re: RegExp): string | null {
  const lines = markdown.split('\n');
  const out: string[] = [];
  let capturing = false;
  let level = 0;
  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.*)$/);
    if (m) {
      const thisLevel = m[1].length;
      if (capturing && thisLevel <= level) break;
      if (!capturing && re.test(m[2])) {
        capturing = true;
        level = thisLevel;
        continue;
      }
    }
    if (capturing) out.push(line);
  }
  return capturing ? out.join('\n') : null;
}

describe('CGLAB-86 — codexrules/AGENTS.md async long-command guidance', () => {
  it('has a dedicated section about long-running / async commands', () => {
    const body = sectionBody(bundle, /long[- ]running|async|background/i);
    expect(body, 'bundle must contain a heading matching long-running/async/background').not.toBeNull();
  });

  it('names Codex\'s async mechanism (yield_time_ms) so the agent can actually do it', () => {
    const body = sectionBody(bundle, /long[- ]running|async|background/i);
    expect(body ?? '').toContain('yield_time_ms');
  });

  it('covers the test-suite scenario (agenfk log-test / the project test command)', () => {
    const body = sectionBody(bundle, /long[- ]running|async|background/i);
    expect(body ?? '').toMatch(/log-test|test suite|tests/i);
  });

  it('covers the transition-to-DONE scenario (agenfk verify running the verify command)', () => {
    const body = sectionBody(bundle, /long[- ]running|async|background/i);
    expect(body ?? '').toMatch(/verify/);
    expect(body ?? '').toMatch(/DONE/);
  });

  it('instructs waiting for the completed result rather than assuming the outcome', () => {
    const body = sectionBody(bundle, /long[- ]running|async|background/i);
    expect(body ?? '').toMatch(/wait|complet|finished/i);
  });
});
