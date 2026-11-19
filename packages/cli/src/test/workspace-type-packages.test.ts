/**
 * Guard rails for the `@types/*` packages declared across the workspace.
 *
 * Dependabot keeps proposing bumps of type packages that should not move the
 * way it suggests (#370, #317). These tests pin the decisions so a later bump
 * cannot quietly undo them.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { createRequire } from 'module';
import { load } from 'js-yaml';

const repoRoot = join(__dirname, '../../../..');

type Manifest = {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

const readManifest = (dir: string): Manifest =>
  JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest;

/** The root manifest plus every packages/* manifest, keyed by a readable label. */
const manifests: Array<[string, Manifest]> = [
  ['(root)', readManifest(repoRoot)],
  ...readdirSync(join(repoRoot, 'packages'))
    .map(name => join(repoRoot, 'packages', name))
    .filter(dir => existsSync(join(dir, 'package.json')))
    .map(dir => [`packages/${dir.split(/[\\/]/).pop()}`, readManifest(dir)] as [string, Manifest]),
];

const allDeps = (m: Manifest): Record<string, string> => ({
  ...m.dependencies,
  ...m.devDependencies,
  ...m.peerDependencies,
});

/** The lowest Node major the repo supports, from the root manifest's `engines.node` (e.g. "^22.13.0 || >=23.5.0" -> 22). */
const supportedNodeMajor = (): number => {
  const engines = (readManifest(repoRoot) as { engines?: { node?: string } }).engines?.node ?? '';
  const majors = [...engines.matchAll(/(\d+)\.\d+/g)].map(m => Number(m[1]));
  return Math.min(...majors);
};

describe('@types/node matches the lowest supported Node (#317)', () => {
  const floor = supportedNodeMajor();
  const declared = manifests
    .map(([label, m]) => [label, allDeps(m)['@types/node']] as const)
    .filter((entry): entry is readonly [string, string] => entry[1] !== undefined);

  it('the root engines field names a Node floor', () => {
    expect(Number.isFinite(floor)).toBe(true);
  });

  it('at least one workspace declares @types/node (the check is not vacuous)', () => {
    expect(declared.length).toBeGreaterThan(0);
  });

  it('every workspace pins @types/node to the floor major', () => {
    // Types newer than the floor would let code use APIs a supported Node does not have.
    const offenders = declared
      .filter(([, range]) => !new RegExp(`^\\^${floor}\\.`).test(range))
      .map(([label, range]) => `${label}: ${range}`);
    expect(offenders, `@types/node not on ^${floor}: ${offenders.join(', ')}`).toEqual([]);
  });

  it('the hoisted @types/node that installs is on the floor major', () => {
    // Transitive peers (@types/through "*", @inquirer ">=18") can hoist a newer major
    // unless the root manifest pins it; check what actually resolves, not only the ranges.
    const fromRoot = createRequire(join(repoRoot, 'package.json'));
    const { version } = JSON.parse(
      readFileSync(fromRoot.resolve('@types/node/package.json'), 'utf8'),
    ) as { version: string };
    expect(Number(version.split('.')[0]), `hoisted @types/node is ${version}`).toBe(floor);
  });

  it('Dependabot ignores semver-major bumps of @types/node', () => {
    const yml = readFileSync(join(repoRoot, '.github/dependabot.yml'), 'utf8');
    const { updates } = load(yml) as {
      updates: Array<{ 'package-ecosystem': string; ignore?: Array<{ 'dependency-name': string; 'update-types'?: string[] }> }>;
    };
    const npm = updates.find(u => u['package-ecosystem'] === 'npm');
    const rule = npm?.ignore?.find(i => i['dependency-name'] === '@types/node');
    expect(rule?.['update-types']).toContain('version-update:semver-major');
  });
});

describe('@types/uuid is not declared (#370)', () => {
  it('uuid ships its own type declarations', () => {
    // Resolve from the consumer, not the root, so a differently-hoisted copy is not checked instead.
    const fromConsumer = createRequire(join(repoRoot, 'packages/storage-sqlite/package.json'));
    const uuidPkg = JSON.parse(
      readFileSync(fromConsumer.resolve('uuid/package.json'), 'utf8'),
    ) as { types?: string; typings?: string; exports?: unknown };
    const exportsTypes = /"types"\s*:/.test(JSON.stringify(uuidPkg.exports ?? {}));
    expect(Boolean(uuidPkg.types ?? uuidPkg.typings) || exportsTypes, 'uuid no longer ships types').toBe(true);
  });

  it('no workspace manifest declares @types/uuid', () => {
    const offenders = manifests
      .filter(([, m]) => '@types/uuid' in allDeps(m))
      .map(([label]) => label);
    expect(offenders, `@types/uuid declared in: ${offenders.join(', ')}`).toEqual([]);
  });
});
