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
  { name: 'qs', vulnerable: '>=6.7.0 <6.16.1', safe: '6.16.1' },
  { name: 'hono', vulnerable: '<4.13.11', safe: '4.13.11' },
  { name: 'ip-address', vulnerable: '>=10.0.0 <10.7.4', safe: '10.7.4' },
  { name: 'fast-uri', vulnerable: '<3.1.9', safe: '3.1.9' },
  { name: 'katex', vulnerable: '<0.18.2', safe: '0.18.2' },
  { name: 'fflate', vulnerable: '>=0.4.0 <0.4.9', safe: '0.4.9' },
  { name: 'postcss-selector-parser', vulnerable: '>=6.0.0 <6.1.5', safe: '6.1.5' },
];

// Dev and build tooling (Story 3, card 663fb16b).
const DEV_TOOLING: Advisory[] = [
  { name: 'undici', vulnerable: '>=6.0.0 <6.29.1 || >=7.0.0 <7.30.1', safe: '6.29.1 / 7.30.1' },
  { name: 'js-yaml', vulnerable: '>=4.0.0 <4.3.2', safe: '4.3.2' },
  { name: 'immutable', vulnerable: '>=4.0.0 <4.3.9', safe: '4.3.9' },
  { name: 'moment', vulnerable: '<2.31.0', safe: '2.31.0' },
  { name: '@vitest/mocker', vulnerable: '>=4.0.0 <4.1.12', safe: '4.1.12' },
  { name: '@humanfs/node', vulnerable: '<0.16.8', safe: '0.16.8' },
];

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

describe('vulnerability guard is not vacuous', () => {
  it('every guarded package is present in package-lock.json at least once', () => {
    const missing = [...RUNTIME, ...DEV_TOOLING]
      .map(a => a.name)
      .filter(name => installedCopies(name).length === 0);
    expect(missing, `not found in package-lock.json: ${missing.join(', ')}`).toEqual([]);
  });
});
