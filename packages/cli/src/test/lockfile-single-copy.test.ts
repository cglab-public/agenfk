/**
 * Packages whose copies must agree across the workspace.
 *
 * The board, the hub UI and flow-editor's type-scale test all compile the same
 * tailwind stylesheets (through lightningcss). When the lockfile carries two tailwind versions, the
 * test compiles with one engine while the apps ship with another, so a green
 * test no longer proves what the apps build (#369 review, #368).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const repoRoot = join(__dirname, '../../../..');

type Lock = { packages: Record<string, { version?: string; link?: boolean }> };
const lock = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8')) as Lock;

/** Every installed version of `name`, keyed by the lockfile path that holds it. */
const installedVersions = (name: string): Map<string, string> => {
  const found = new Map<string, string>();
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!entry.link && entry.version && path.endsWith(`node_modules/${name}`)) found.set(path, entry.version);
  }
  return found;
};

describe('one tailwind version across the workspace', () => {
  for (const name of ['tailwindcss', '@tailwindcss/node', '@tailwindcss/postcss', 'lightningcss']) {
    it(`the lockfile installs a single version of ${name}`, () => {
      const copies = installedVersions(name);
      expect(copies.size, `${name} is not in the lockfile`).toBeGreaterThan(0);
      const versions = new Set(copies.values());
      expect(
        [...versions],
        `${name} copies: ${[...copies].map(([p, v]) => `${p}@${v}`).join(', ')}`,
      ).toHaveLength(1);
    });
  }
});
