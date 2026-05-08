/**
 * The /agenfk-release and /agenfk-release-beta skills bump manifest version
 * strings (package.json, pyproject.toml, *.csproj, …). They must ALSO
 * regenerate the matching lockfile in the same commit, otherwise the
 * lockfile drifts away from the manifest and consumers running `npm ci`
 * (or `poetry install --no-update`, etc.) end up with version mismatches.
 *
 * Concrete miss this test was added to prevent: every AgEnFK beta from
 * 0.3.0-beta.23 onwards shipped a package-lock.json still pinned to
 * 0.3.0-beta.22 because the bump path edited package.json but never ran
 * `npm install --package-lock-only`.
 *
 * Both skill files ship to AgEnFK users on Node, Python, Rust, Go, .NET,
 * etc. — so the guidance must be stack-aware (detect the lockfile present
 * in the repo, run the matching tool), not Node-specific.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const release = readFileSync(path.resolve(__dirname, '../../../../commands/agenfk-release.md'), 'utf8');
const beta = readFileSync(path.resolve(__dirname, '../../../../commands/agenfk-release-beta.md'), 'utf8');

const skills = [
  ['agenfk-release', release],
  ['agenfk-release-beta', beta],
] as const;

describe('release skills regenerate the lockfile after bumping the manifest', () => {
  for (const [name, src] of skills) {
    describe(name, () => {
      it('mentions lockfile regeneration explicitly so the executor knows it is mandatory', () => {
        expect(src.toLowerCase()).toMatch(/regenerate|update.+lockfile|lockfile.+regen/);
      });

      it('lists the npm lockfile pairing (this repo is npm-based, so we must keep at least Node coverage)', () => {
        expect(src).toMatch(/package-lock\.json/);
        expect(src).toMatch(/npm install --package-lock-only/);
      });

      it('covers other common stacks so the skill stays portable across AgEnFK users', () => {
        // Each row of the guidance table — at least one mention each.
        expect(src.toLowerCase()).toMatch(/pnpm-lock\.yaml/);
        expect(src.toLowerCase()).toMatch(/yarn\.lock/);
        expect(src.toLowerCase()).toMatch(/poetry\.lock/);
        expect(src.toLowerCase()).toMatch(/uv\.lock/);
        expect(src.toLowerCase()).toMatch(/cargo\.lock/);
      });

      it('says to commit the lockfile in the same `chore: bump version` commit', () => {
        const lower = src.toLowerCase();
        // The phrasing might vary, but the *intent* — lockfile travels with the manifest in one commit — must be unmistakable.
        expect(lower).toMatch(/(stage|include|commit).+(lockfile|package-lock)/);
      });

      it('treats "no lockfile in tree" as a no-op rather than an error (so non-locked stacks still release fine)', () => {
        expect(src.toLowerCase()).toMatch(/no.?op|skip|do not error|no lockfile/);
      });
    });
  }
});
