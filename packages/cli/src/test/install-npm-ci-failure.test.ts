/**
 * Issue #232 — a failed `npm ci` must fail the install.
 *
 * install.mjs reduced a failing `npm ci --omit=dev` to a warning and went on to
 * print "✓ AgEnFK <v> installed". `agenfk upgrade` treats a zero exit from
 * install.mjs as success, so it printed "✓ Upgraded to <v>" while production
 * dependencies had silently stopped updating.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import { mkdtempSync } from 'fs';
import { runInstall, makeHome, cleanupHome, REPO_ROOT, type RunResult } from './helpers/runInstaller';
import { fakeBin } from './helpers/fakeBin';

// eslint-disable-next-line no-control-regex
const lines = (r: RunResult) => (r.stdout + '\n' + r.stderr).replace(/\x1b\[[0-9;]*m/g, '').split('\n').map((l) => l.trim()).filter(Boolean);

function failingNpm(): NodeJS.ProcessEnv {
  const b = fakeBin(mkdtempSync(path.join(os.tmpdir(), 'agenfk-bad-npm-')), {
    stubs: { npm: `console.log('npm ERR! code E404 (fake)'); process.exit(1);` },
  });
  return b.env();
}

describe('install.mjs when npm ci fails (#232)', () => {
  for (const quiet of [false, true]) {
    describe(quiet ? 'with --quiet (what agenfk upgrade runs)' : 'interactive', () => {
      let r: RunResult;
      beforeAll(() => {
        const home = makeHome('agenfk-npmci-fail');
        r = runInstall(['--rules-scope=global', ...(quiet ? ['--quiet'] : [])], home, undefined, failingNpm() as Record<string, string>);
      });
      afterAll(() => cleanupHome(r.home));

      it('exits non-zero, so the upgrade reports a failure', () => {
        expect(r.status).not.toBe(0);
      });

      it('does not claim the install succeeded', () => {
        expect(lines(r).some((l) => /^✓ AgEnFK .*installed/.test(l))).toBe(false);
      });

      it('ends by saying the install is not complete, and how to repair it', () => {
        const out = lines(r);
        expect(out.some((l) => /^✗ AgEnFK .*NOT fully installed: npm ci failed/.test(l))).toBe(true);
        // Directory and command on lines of their own: a path is not shell-safe
        // to splice into one copyable command on every OS (#232 review).
        const at = out.findIndex((l) => /^Repair it: in /.test(l));
        expect(at).toBeGreaterThan(-1);
        // install.mjs repairs the tree it runs from: here, this checkout.
        expect(out[at]).toBe(`Repair it: in ${REPO_ROOT}, run`);
        expect(out[at + 1]).toBe('npm ci --omit=dev --ignore-scripts');
      });

      it('fails on purpose, not by crashing', () => {
        expect(r.stdout + r.stderr).not.toMatch(/ReferenceError|TypeError|at run \(/);
      });
    });
  }
});

describe('install.mjs --rules-only does not touch dependencies (#232 review)', () => {
  let r: RunResult;
  beforeAll(() => {
    r = runInstall(['--rules-only', '--rules-scope=global'], makeHome('agenfk-rules-only'), undefined, failingNpm() as Record<string, string>);
  });
  afterAll(() => cleanupHome(r.home));

  it('succeeds with a failing npm, because it never runs npm ci', () => {
    expect(r.status).toBe(0);
    expect(lines(r).join('\n')).not.toMatch(/npm ci failed/);
    expect(lines(r).some((l) => /^✓ AgEnFK workflow rules installed/.test(l))).toBe(true);
  });
});

describe('install.mjs when npm ci succeeds', () => {
  let r: RunResult;
  beforeAll(() => { r = runInstall(['--rules-scope=global']); });
  afterAll(() => cleanupHome(r.home));

  it('exits 0 and says it installed', () => {
    expect(r.status).toBe(0);
    expect(lines(r).some((l) => /^✓ AgEnFK .*installed/.test(l))).toBe(true);
  });
});
