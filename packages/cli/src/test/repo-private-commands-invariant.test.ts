/**
 * Invariant: every command living in the repo-private `.claude/commands/` must
 * be named in REPO_PRIVATE_NAMES.
 *
 * That list is the ONLY thing stopping the leak on the routes where the install
 * dir is never pruned — `--rebuild`, the download-failure fallback, and scoped
 * `--only=` runs. A fourth repo-private release command added upstream would
 * re-open the leak there with nothing to catch it, and the list is mirrored in
 * two places (scripts/install-helpers.mjs and packages/cli/src/index.ts) that
 * can drift. This makes the drift a test failure instead of a silent leak.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'fs';
import path from 'path';
import { REPO_ROOT } from './helpers/runInstaller';
// @ts-ignore — .mjs has no .d.ts
import { isRepoPrivateCommand } from '../../../../scripts/install-helpers.mjs';

const repoPrivateDir = path.join(REPO_ROOT, '.claude', 'commands');
const shippedDir = path.join(REPO_ROOT, 'commands');

/** The names as bare basenames, e.g. 'agenfk-release'. */
function repoPrivateNames(): string[] {
  return readdirSync(repoPrivateDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace(/\.md$/, ''));
}

describe('repo-private release commands stay in sync with the copy-site filter', () => {
  it('names every command sitting in the repo-private .claude/commands dir', () => {
    expect(existsSync(repoPrivateDir)).toBe(true);
    const names = readdirSync(repoPrivateDir).filter((f) => f.endsWith('.md'));
    expect(names.length).toBeGreaterThan(0); // guard: an empty dir proves nothing
    const unlisted = names.filter((f) => !isRepoPrivateCommand(f));
    expect(
      unlisted,
      `add ${JSON.stringify(unlisted)} to REPO_PRIVATE_NAMES in BOTH scripts/install-helpers.mjs and packages/cli/src/index.ts`,
    ).toEqual([]);
  });

  it('keeps the repo-private commands out of the shipped commands/ dir', () => {
    // The two dirs must not overlap: a repo-private command that is also shipped
    // would be filtered out of the install it is supposed to be part of.
    const shipped = new Set(readdirSync(shippedDir).filter((f) => f.endsWith('.md')));
    const names = readdirSync(repoPrivateDir).filter((f) => f.endsWith('.md'));
    const overlap = names.filter((n) => shipped.has(n));
    expect(overlap).toEqual([]);
  });

  it('carries every repo-private name in the CLI mirror too', () => {
    // The list is MIRRORED in packages/cli/src/index.ts, which cannot import
    // scripts/. Asserting equality here turns a forgotten mirror update into a
    // test failure instead of a silent leak through `agenfk skills install`.
    const cliSource = readFileSync(path.join(REPO_ROOT, 'packages', 'cli', 'src', 'index.ts'), 'utf8');
    const literal = cliSource.match(/const REPO_PRIVATE_NAMES\s*=\s*\[([^\]]*)\]/);
    expect(literal, 'REPO_PRIVATE_NAMES not found in packages/cli/src/index.ts').toBeTruthy();
    const mirrored = [...literal![1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    expect(mirrored).toEqual(repoPrivateNames().sort());
  });
});
