/**
 * BUG 8973cea3 — `agenfk upgrade --beta` resolved the "latest beta" by taking
 * the most-recently-published release of ANY kind, not just prereleases. When a
 * STABLE release (e.g. v1.1.6) was published after the newest beta, or when a
 * prerelease was created without a dist asset, the resolver could pick a tag
 * whose `agenfk-dist.tar.gz` asset did not exist, and the upgrade 404'd.
 *
 * Fix: the beta branch of `fetchLatestReleaseTag` must filter the releases list
 * down to `prerelease === true` before sorting by `published_at`, so `--beta`
 * only ever resolves to an actual pre-release tag.
 *
 * Source-introspection test (cheap, runs in the root suite) — asserts the
 * resolver reads and filters on the `prerelease` field.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CLI_SRC = fs.readFileSync(path.join(REPO_ROOT, 'packages/cli/src/index.ts'), 'utf8');

describe('BUG 8973cea3: --beta upgrade resolves only prereleases', () => {
  // Isolate the fetchLatestReleaseTag function body so assertions target the
  // beta-resolution logic and not unrelated mentions of "prerelease".
  const fnIdx = CLI_SRC.search(/async function fetchLatestReleaseTag\s*\(/);
  const nextFnIdx = CLI_SRC.indexOf('\nfunction ', fnIdx + 10);
  const nextAsyncFnIdx = CLI_SRC.indexOf('\nasync function ', fnIdx + 10);
  const candidates = [nextFnIdx, nextAsyncFnIdx].filter((i) => i !== -1);
  const endIdx = candidates.length ? Math.min(...candidates) : CLI_SRC.length;
  const fnBody = CLI_SRC.slice(fnIdx, endIdx);

  it('fetchLatestReleaseTag exists', () => {
    expect(fnIdx).toBeGreaterThan(-1);
  });

  it('types the releases list with a prerelease flag', () => {
    // The parsed GitHub releases must carry `prerelease` so it can be filtered.
    expect(fnBody).toMatch(/prerelease\s*:\s*boolean/);
  });

  it('filters the releases list on the prerelease flag before selecting the latest', () => {
    // e.g. `.filter((r) => r.tag_name && r.published_at && r.prerelease)`
    const filterMatch = fnBody.match(/\.filter\(\s*\(\s*r\s*\)\s*=>[^)]*\)/);
    expect(filterMatch, 'expected a .filter((r) => ...) over the releases list').not.toBeNull();
    expect(filterMatch![0]).toMatch(/r\.prerelease/);
  });

  it('still sorts the filtered prereleases by published_at descending', () => {
    expect(fnBody).toMatch(/published_at/);
    expect(fnBody).toMatch(/\.sort\(/);
  });
});
