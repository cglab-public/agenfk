/**
 * Issue #257 — the Node version AgEnFK advertises must run every runtime
 * dependency it ships.
 *
 * jwks-rsa 4 requires the ESM-only jose 6 and declares `node ^22.12.0`, while
 * AgEnFK still advertised `>=22.5.0`: a hub started on 22.5-22.11 failed with
 * ERR_REQUIRE_ESM, even with Entra off. A floor below a dependency's own floor
 * is a promise the install cannot keep, so every Node version the root
 * `engines.node` accepts must also be accepted by each shipped package's
 * direct runtime dependencies.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import semver from 'semver';

const ROOT = path.resolve(__dirname, '../../../..');
const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const rootPkg = readJson(path.join(ROOT, 'package.json'));

// The workspaces whose code runs on the user's Node (the board and hub UI are
// browser bundles, and the desktop app runs on Electron's own Node).
const NODE_WORKSPACES = ['core', 'cli', 'server', 'storage-sqlite', 'telemetry', 'hub', 'create'];

// The installed manifest of `dep` as Node would find it from `fromDir`: the
// nearest node_modules/<dep>/package.json walking up. require.resolve cannot
// be used, because a package whose `exports` omits ./package.json refuses it.
function manifestDirOf(dep: string, fromDir: string): string | null {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', dep);
    if (existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (path.dirname(dir) === dir) return null;
  }
}

// Every package in the installed runtime dependency closure of the Node-side
// workspaces, transitive dependencies included, with the engines range it declares.
function runtimeDependencyEngines(): { owner: string; dep: string; range: string }[] {
  const out: { owner: string; dep: string; range: string }[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();
  const queue: { owner: string; from: string; deps: Record<string, string> }[] = NODE_WORKSPACES.map((ws) => {
    const dir = path.join(ROOT, 'packages', ws);
    return { owner: ws, from: dir, deps: readJson(path.join(dir, 'package.json')).dependencies ?? {} };
  });
  while (queue.length) {
    const { owner, from, deps } = queue.shift()!;
    for (const dep of Object.keys(deps)) {
      if (dep.startsWith('@agenfk/')) continue;
      const dir = manifestDirOf(dep, from);
      if (!dir) { unresolved.push(`${owner} -> ${dep}`); continue; }
      if (seen.has(dir)) continue;
      seen.add(dir);
      const manifest = readJson(path.join(dir, 'package.json'));
      const range = manifest.engines?.node;
      if (typeof range === 'string' && semver.validRange(range)) out.push({ owner, dep, range });
      queue.push({ owner, from: dir, deps: manifest.dependencies ?? {} });
    }
  }
  // A dependency the install cannot find is not one this test may skip.
  expect(unresolved).toEqual([]);
  return out;
}

describe('the advertised Node floor runs every shipped dependency (#257)', () => {
  it('finds dependency engine ranges to check against', () => {
    // Guard against the check passing vacuously because nothing was resolved.
    expect(runtimeDependencyEngines().length).toBeGreaterThan(5);
  });

  it('every Node version the root engines.node accepts is accepted by each dependency', () => {
    const floor: string = rootPkg.engines.node;
    // The floor's own minimum, then the first release of each later major up to
    // the one running this test. semver.subset cannot be used: it requires the
    // floor to fit inside ONE alternative of a `||` range, not their union.
    const lowest = semver.minVersion(floor)!;
    const accepted = [lowest.version];
    for (let major = lowest.major + 1; major <= semver.major(process.version); major++) accepted.push(`${major}.0.0`);
    const tooLow = runtimeDependencyEngines()
      .flatMap(({ owner, dep, range }) => accepted
        .filter((v) => semver.satisfies(v, floor) && !semver.satisfies(v, range))
        .map((v) => `${owner} -> ${dep} needs node ${range}, but ${v} is accepted`));
    expect(tooLow, `root engines.node is "${floor}"`).toEqual([]);
  });

  it('the published packages advertise the same floor as the root', () => {
    for (const ws of ['create', 'hub']) {
      const pkg = readJson(path.join(ROOT, 'packages', ws, 'package.json'));
      expect(pkg.engines?.node, `packages/${ws}`).toBe(rootPkg.engines.node);
    }
  });
});
