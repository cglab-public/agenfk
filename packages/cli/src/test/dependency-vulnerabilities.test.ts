/**
 * EPIC #320 / issue #325 — no installed copy of a dependency may sit inside a
 * known-vulnerable range.
 *
 * Dependabot flagged transitive dependencies whose locked versions fall inside
 * published advisory ranges. The fix is an upgrade (or an override) in the
 * lockfile, and nothing else would notice a later `npm install` pulling a
 * vulnerable copy back in, so this guard reads the root package-lock.json and
 * checks EVERY copy of each package — hoisted and nested
 * (`node_modules/a/node_modules/<name>`) alike — against its vulnerable range.
 *
 * The ranges live here, in the test, on purpose: they are the specification.
 * When an advisory covers several release lines (vite 7 and 8, undici 6 and 7),
 * the range is the `||` union of every affected line, so a copy that falls back
 * onto any of them is flagged.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import semver from 'semver';

const ROOT = path.resolve(__dirname, '../../../..');
const lock = JSON.parse(readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8')) as {
  packages: Record<string, { version?: string; link?: boolean }>;
};

interface Advisory {
  name: string;
  vulnerable: string;
  safe: string;
}

// Runtime dependencies (Story 2, card 57231531).
const RUNTIME: Advisory[] = [
  { name: 'dompurify', vulnerable: '<3.4.17', safe: '3.4.17' },
  { name: 'follow-redirects', vulnerable: '<1.16.2', safe: '1.16.2' },
  { name: 'engine.io', vulnerable: '<6.6.10', safe: '6.6.10' },
  {
    name: 'vite',
    vulnerable: '>=7.0.0 <7.3.7 || >=8.0.0 <8.1.6 || >=8.2.0 <8.2.4 || >=8.3.0 <8.3.3',
    safe: '7.3.7 / 8.3.3',
  },
  { name: 'qs', vulnerable: '>=2.2.5 <6.16.1', safe: '6.16.1' },
  { name: 'hono', vulnerable: '<4.13.11', safe: '4.13.11' },
  { name: 'ip-address', vulnerable: '<10.7.4', safe: '10.7.4' },
  { name: 'fast-uri', vulnerable: '<3.1.9', safe: '3.1.9' },
  { name: 'katex', vulnerable: '<0.18.2', safe: '0.18.2' },
  { name: 'fflate', vulnerable: '>=0.4.0 <0.4.9', safe: '0.4.9' },
  { name: 'postcss-selector-parser', vulnerable: '<6.1.5', safe: '6.1.5' },
];

// Dev and build tooling (Story 3, card 663fb16b).
const DEV_TOOLING: Advisory[] = [
  { name: 'undici', vulnerable: '>=6.0.0 <6.29.1 || >=7.0.0 <7.30.1', safe: '6.29.1 / 7.30.1' },
  { name: 'js-yaml', vulnerable: '>=4.0.0 <4.3.2', safe: '4.3.2' },
  { name: 'immutable', vulnerable: '>=4.0.0-beta.1 <4.3.9', safe: '4.3.9' },
  { name: 'moment', vulnerable: '<2.31.0', safe: '2.31.0' },
  { name: '@vitest/mocker', vulnerable: '>=2.1.0-beta.7 <4.1.12', safe: '4.1.12' },
  { name: '@humanfs/node', vulnerable: '<0.16.8', safe: '0.16.8' },
];

// Desktop shell (Story 1, card fa492cbf). Every Electron advisory is fixed in
// 42.11.9 or later; electron-builder rides along on its own line.
const DESKTOP: Advisory[] = [{ name: 'electron', vulnerable: '<42.11.9', safe: '42.11.9' }];

// Every installed copy of `name` in the lockfile: its `packages` key and version.
// Workspace links and entries without a version are not installed copies.
function installedCopies(name: string): { at: string; version: string }[] {
  const suffix = `node_modules/${name}`;
  return Object.entries(lock.packages)
    .filter(([key]) => key === suffix || key.endsWith(`/${suffix}`))
    .filter(([, entry]) => !entry.link && typeof entry.version === 'string')
    .map(([at, entry]) => ({ at, version: entry.version as string }));
}

function vulnerableCopies({ name, vulnerable }: Advisory): string[] {
  return installedCopies(name)
    .filter(({ version }) => semver.satisfies(version, vulnerable, { includePrerelease: true }))
    .map(({ at, version }) => `${at}@${version}`);
}

function guard(title: string, advisories: Advisory[]) {
  describe(title, () => {
    for (const advisory of advisories) {
      it(`${advisory.name}: no copy in ${advisory.vulnerable} (needs >=${advisory.safe})`, () => {
        const offending = vulnerableCopies(advisory);
        expect(
          offending,
          `${advisory.name} has copies in the vulnerable range ${advisory.vulnerable}; ` +
            `upgrade to >=${advisory.safe}:\n  ${offending.join('\n  ')}`,
        ).toEqual([]);
      });
    }
  });
}

guard('runtime dependencies are outside their vulnerable ranges', RUNTIME);
guard('dev and build tooling is outside its vulnerable ranges', DEV_TOOLING);
guard('desktop shell is outside its vulnerable ranges', DESKTOP);

describe('packages/desktop pins a fixed Electron', () => {
  const desktop = JSON.parse(readFileSync(path.join(ROOT, 'packages/desktop/package.json'), 'utf8')) as {
    devDependencies: Record<string, string>;
  };

  it('declares an electron version at or above 42.11.9 (alerts are raised on the manifest too)', () => {
    const declared = desktop.devDependencies.electron;
    const floor = semver.minVersion(declared);
    expect(floor, `electron "${declared}" is not a version range`).not.toBeNull();
    expect(semver.gte(floor!, '42.11.9'), `electron "${declared}" allows a version below 42.11.9`).toBe(true);
  });

  it('locks an electron copy that satisfies the manifest range', () => {
    const [copy] = installedCopies('electron');
    expect(copy, 'electron is not in package-lock.json').toBeDefined();
    expect(semver.satisfies(copy.version, desktop.devDependencies.electron)).toBe(true);
  });
});

// Versions the published advisories (GitHub Dependabot data, every alert state)
// name as affected: for each guarded package, the floor of its widest advisory
// (or an older line when the advisory has no floor) and the top edge. Each must
// fall inside the guard's own range, so a range that starts later or stops
// earlier than its advisory (and would let a vulnerable copy back in) fails.
const ADVISORY_AFFECTED: { name: string; version: string; advisory: string }[] = [
  { name: 'dompurify', version: '2.5.0', advisory: '<= 3.4.16' },
  { name: 'dompurify', version: '3.4.16', advisory: '<= 3.4.16' },
  { name: 'follow-redirects', version: '1.16.0', advisory: '>= 1.16.0, < 1.16.1' },
  { name: 'engine.io', version: '6.6.0', advisory: '>= 6.6.0, < 6.6.10' },
  { name: 'engine.io', version: '6.6.9', advisory: '>= 6.6.0, < 6.6.10' },
  { name: 'vite', version: '7.0.0', advisory: '>= 7.0.0, <= 7.3.6' },
  { name: 'vite', version: '7.3.6', advisory: '>= 7.0.0, <= 7.3.6' },
  { name: 'qs', version: '2.2.5', advisory: '>= 2.2.5, < 6.16.0' },
  { name: 'qs', version: '6.5.3', advisory: '>= 2.2.5, < 6.16.0' },
  { name: 'qs', version: '6.15.3', advisory: '>= 6.14.2, <= 6.15.3' },
  { name: 'hono', version: '2.0.0', advisory: '< 4.13.5' },
  { name: 'hono', version: '3.8.0', advisory: '>= 3.8.0, < 4.12.34' },
  { name: 'hono', version: '4.13.10', advisory: '>= 4.12.4, < 4.13.11' },
  { name: 'ip-address', version: '9.0.5', advisory: '<= 10.7.3' },
  { name: 'ip-address', version: '10.7.3', advisory: '<= 10.7.3' },
  { name: 'fast-uri', version: '3.0.0', advisory: '>= 3.0.0, < 3.1.9' },
  { name: 'fast-uri', version: '3.1.8', advisory: '>= 3.0.0, < 3.1.9' },
  { name: 'katex', version: '0.11.0', advisory: '>= 0.11.0, < 0.18.2' },
  { name: 'katex', version: '0.18.1', advisory: '>= 0.11.0, < 0.18.2' },
  { name: 'fflate', version: '0.4.5', advisory: '>= 0.4.5, < 0.4.9' },
  { name: 'fflate', version: '0.4.8', advisory: '>= 0.4.5, < 0.4.9' },
  { name: 'postcss-selector-parser', version: '5.0.0', advisory: '< 6.1.5' },
  { name: 'postcss-selector-parser', version: '6.1.4', advisory: '< 6.1.5' },
  { name: 'undici', version: '6.5.0', advisory: '>= 6.5.0, < 6.29.1' },
  { name: 'undici', version: '6.29.0', advisory: '>= 6.23.0, < 6.29.1' },
  { name: 'undici', version: '7.0.0', advisory: '>= 7.0.0, < 7.30.1' },
  { name: 'undici', version: '7.30.0', advisory: '>= 7.0.0, < 7.30.1' },
  { name: 'js-yaml', version: '4.0.0', advisory: '>= 4.0.0, < 4.3.2' },
  { name: 'js-yaml', version: '4.3.1', advisory: '>= 4.0.0, < 4.3.2' },
  { name: 'immutable', version: '4.0.0-beta.1', advisory: '>= 4.0.0-beta.1, < 4.3.9' },
  { name: 'immutable', version: '4.0.0-rc.1', advisory: '>= 4.0.0-rc.1, < 4.3.9' },
  { name: 'immutable', version: '4.3.8', advisory: '>= 4.0.0-beta.1, < 4.3.9' },
  { name: 'moment', version: '2.29.2', advisory: '>= 2.29.2, < 2.31.0' },
  { name: 'moment', version: '2.30.1', advisory: '>= 2.29.2, < 2.31.0' },
  { name: '@vitest/mocker', version: '2.1.0-beta.7', advisory: '>= 2.1.0-beta.7, < 4.1.12' },
  { name: '@vitest/mocker', version: '3.2.4', advisory: '>= 2.1.0-beta.7, < 4.1.12' },
  { name: '@vitest/mocker', version: '4.1.11', advisory: '>= 4.1.11, < 4.1.12' },
  { name: '@humanfs/node', version: '0.16.7', advisory: '< 0.16.8' },
  { name: 'electron', version: '40.10.6', advisory: '< 42.11.9' },
  { name: 'electron', version: '42.11.8', advisory: '< 42.11.9' },
];

describe('guard ranges cover what the advisories mark as affected', () => {
  for (const { name, version, advisory } of ADVISORY_AFFECTED) {
    it(`${name}@${version} (advisory ${advisory}) is inside the guard range`, () => {
      const guarded = [...RUNTIME, ...DEV_TOOLING, ...DESKTOP].find(a => a.name === name);
      expect(guarded, `${name} is not guarded`).toBeDefined();
      expect(
        semver.satisfies(version, guarded!.vulnerable, { includePrerelease: true }),
        `${name}@${version} is affected per the advisory (${advisory}) but outside ${guarded!.vulnerable}`,
      ).toBe(true);
    });
  }
});

// The katex override puts mermaid 11 (which declares katex ^0.16.47) on katex
// >=0.18.2. Mermaid 11 uses one call: the default export's renderToString with
// these options, then styles `.node .katex path`. Pin that the overridden katex
// still answers it the same way, so a later katex that breaks mermaid fails here.
// katex is not a dependency of packages/cli: `import('katex')` reaches the root
// hoisted copy, which is the one mermaid loads only while no copy is nested
// under mermaid, so that is asserted first.
describe('overridden katex still serves the call mermaid 11 makes', () => {
  it('mermaid has no nested katex, so the root copy tested here is the one it loads', () => {
    const nested = Object.keys(lock.packages).filter(key => key.endsWith('mermaid/node_modules/katex'));
    expect(nested).toEqual([]);
    expect(installedCopies('katex').map(c => c.at)).toEqual(['node_modules/katex']);
  });

  for (const output of ['mathml', 'htmlAndMathml'] as const) {
    it(`renderToString(..., { throwOnError, displayMode, output: '${output}' }) renders MathML`, async () => {
      const { default: katex } = await import('katex');
      const html = katex.renderToString('\\sqrt{2} + \\frac{a}{b}', {
        throwOnError: true,
        displayMode: true,
        output,
      });
      expect(html).toContain('<math');
      if (output === 'htmlAndMathml') {
        expect(html).toContain('class="katex"');
        expect(html).toContain('<path');
      }
    });
  }

  it('still throws on malformed input, which mermaid relies on (throwOnError: true)', async () => {
    const { default: katex } = await import('katex');
    expect(() =>
      katex.renderToString('\\frac{', { throwOnError: true, displayMode: true, output: 'mathml' }),
    ).toThrow();
  });
});

describe('vulnerability guard is not vacuous', () => {
  it('every guarded package is present in package-lock.json at least once', () => {
    const missing = [...RUNTIME, ...DEV_TOOLING, ...DESKTOP]
      .map(a => a.name)
      .filter(name => installedCopies(name).length === 0);
    expect(missing, `not found in package-lock.json: ${missing.join(', ')}`).toEqual([]);
  });
});
