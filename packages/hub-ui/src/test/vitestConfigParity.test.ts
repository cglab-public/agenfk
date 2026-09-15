// The hub-ui vitest config must not drift from the ROOT one (BUG 8cddfdc2).
//
// hub-ui specs run two ways: CI runs `npm test` at the repo root, and a
// developer iterating runs vitest inside packages/hub-ui. Those two used to
// disagree — the local side had no config at all, so it missed the localStorage
// shim and testing-library's automatic cleanup, and produced 36 failures that
// had nothing to do with the code under test. Someone reading that reasonably
// concludes the board is red when it is green.
//
// These compare the LOCAL config against the ROOT config, not against the
// helper both happen to call — comparing a config to its own ingredients is
// tautological, and misses exactly the settings the root adds on top (aliases,
// defines), which is where the remaining drift actually was.
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import localConfig from '../../vitest.config';
import rootConfig from '../../../../vitest.config';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '../..');
const REPO_ROOT = path.resolve(HERE, '../../../..');

/** Vite configs may export a function; ours are objects, but normalise anyway. */
const resolve = (c: unknown): any =>
  typeof c === 'function' ? (c as any)({ command: 'serve', mode: 'test' }) : c;

const local = resolve(localConfig);
const root = resolve(rootConfig);
/** The root entry that governs hub-ui specs. */
const rootParallel = resolve(root.test.projects.find((p: any) => p.test.name === 'parallel'));

describe('hub-ui vitest config parity with the root run', () => {
  it('loads a setup file that exists where vitest will look for it', () => {
    // vitest resolves setupFiles against the PROJECT root, so this must resolve
    // from packages/hub-ui — not from the repo root, which is what made an
    // earlier version of this test green against a config vitest could not load.
    const setupFiles: string[] = local.test?.setupFiles ?? [];
    const resolved = setupFiles.map(f => path.resolve(PKG_ROOT, f));
    expect(resolved.length).toBeGreaterThan(0);
    for (const f of resolved) expect(fs.existsSync(f), `${f} does not exist`).toBe(true);
    expect(resolved.some(f => path.basename(f) === 'vitest.setup.ts')).toBe(true);
  });

  it('enables globals, which is what registers testing-library cleanup', () => {
    expect(local.test?.globals).toBe(true);
    expect(local.test?.globals).toBe(rootParallel.test.globals);
  });

  it('carries the aliases the root run resolves specs with', () => {
    // A spec importing @agenfk/core would otherwise pass at root and fail here
    // on an unresolved import — the same confusing split, one package deeper.
    const rootAlias = root.resolve?.alias ?? {};
    const localAlias = local.resolve?.alias ?? {};
    for (const key of Object.keys(rootAlias)) {
      expect(localAlias[key], `alias ${key} is missing locally`).toBe(rootAlias[key]);
    }
  });

  it('carries the build-time defines the root run injects', () => {
    for (const key of Object.keys(root.define ?? {})) {
      expect(local.define?.[key], `define ${key} is missing locally`).toBeDefined();
    }
  });

  it('keeps tests within a file serial, since they share one jsdom document', () => {
    // 95 specs fail with concurrent renders into one document. The root run is
    // serial in practice too: its root-level test block re-serialises what
    // PARALLEL_INCLUDE asks for.
    expect(local.test.sequence?.concurrent).toBeFalsy();
    expect(root.test.sequence?.concurrent).toBeFalsy();
  });

  it('keeps the test config out of the production build', () => {
    // vite.config.ts is what `vite build` loads, including inside
    // packages/hub/Dockerfile — which never copies scripts/. A test-only import
    // there breaks the hub image, and only at hub-v* release time.
    const viteConfig = fs.readFileSync(path.join(PKG_ROOT, 'vite.config.ts'), 'utf8');
    expect(viteConfig).not.toMatch(/vitest-shared-config/);
    expect(viteConfig).not.toMatch(/\btest\s*:/);
  });
});
