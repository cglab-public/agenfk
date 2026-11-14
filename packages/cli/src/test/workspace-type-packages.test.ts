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
