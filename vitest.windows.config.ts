import { defineConfig } from 'vitest/config';
import { sharedResolve, sharedTest } from './scripts/vitest-shared-config.mjs';

/**
 * The curated, platform-sensitive subset (issue #201): `npm run test:windows`.
 *
 * CI no longer runs it: since #208 the whole suite passes on Windows and the
 * `windows-full` job runs all of it, sharded. This subset stays as the QUICK
 * local check on a Windows box, where the full suite can take over an hour. It
 * targets what only Windows can break — paths, accents/spaces in the user
 * profile, child processes, installer/hook scripts, CRLF.
 *
 * Convention: a spec named `*.xplat.test.ts` is cross-platform by contract. It
 * runs here AND in the normal `npm test` on every OS.
 */
export const WINDOWS_INCLUDE = [
  // Cross-platform by contract (also part of the regular run).
  'packages/*/src/test/**/*.xplat.test.{ts,tsx}',
  // Windows-specific regressions (#192 hook paths, #200 windowsHide, ...).
  'packages/*/src/test/**/windows-*.test.{ts,tsx}',
  // Installer / uninstaller / packaging: they build paths and wrapper scripts.
  'packages/cli/src/test/install-*.test.ts',
  'packages/cli/src/test/uninstall-*.test.ts',
  'packages/cli/src/test/packaging-*.test.ts',
  'packages/cli/src/test/branch-command.test.ts',
  // Fast, fs-light packages that carry the persistence and path logic.
  'packages/core/src/test/**/*.{test,spec}.{ts,tsx}',
  'packages/storage-sqlite/src/test/**/*.{test,spec}.{ts,tsx}',
];

/**
 * Real Windows gaps, listed rather than hidden: each is a bug to fix (then
 * delete the line), not a test to bless. Empty since #208 - the two it held
 * (install-prunes-against-tarball: the node.exe symlink EPERM; install-cli-
 * only-default: #192 hook bins) pass on Windows now.
 */
export const WINDOWS_KNOWN_GAPS: string[] = [];

const base = sharedTest({ include: WINDOWS_INCLUDE });

export default defineConfig({
  define: {
    __AGENFK_VERSION__: JSON.stringify('test'),
  },
  resolve: sharedResolve,
  // One file at a time: the selected specs share the per-run HOME sandbox.
  test: { ...base, exclude: [...base.exclude, ...WINDOWS_KNOWN_GAPS] },
});
