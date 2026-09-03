import { defineConfig } from 'vitest/config';
import { sharedResolve, sharedTest } from './scripts/vitest-shared-config.mjs';

/**
 * Test files that touch no shared filesystem state, so their files may run
 * concurrently instead of one-at-a-time.
 *
 * `fileParallelism: false` exists because tests share filesystem state (sqlite
 * DBs, install dirs) and because every worker is pinned to a single per-run
 * HOME sandbox (scripts/vitest-home-pin.mjs). That constraint is real for
 * server/hub/cli — but it also serialised ~90 files that are pure logic or
 * that mock `os.homedir()` per file, and serialising those was most of the
 * wall clock. These packages qualify:
 *   - core: workflow/flow/semver/gatekeeper logic, zero fs access
 *   - hub-ui, ui, flow-editor: jsdom component specs
 *   - storage-sqlite, telemetry: fs-touching, but each file uses its own
 *     mkdtemp dir or a mocked `os.homedir()`, so there is no cross-file
 *     contention
 * Anything under packages/server, packages/hub or packages/cli stays serial.
 */
const PARALLEL_INCLUDE = [
  'packages/core/src/test/**/*.{test,spec}.{ts,tsx}',
  'packages/storage-sqlite/src/test/**/*.{test,spec}.{ts,tsx}',
  'packages/telemetry/src/test/**/*.{test,spec}.{ts,tsx}',
  'packages/hub-ui/src/test/**/*.{test,spec}.{ts,tsx}',
  'packages/ui/src/test/**/*.{test,spec}.{ts,tsx}',
  'packages/flow-editor/src/test/**/*.{test,spec}.{ts,tsx}',
];

const SERIAL_INCLUDE = [
  'packages/server/src/test/**/*.{test,spec}.{ts,tsx}',
  'packages/hub/src/test/**/*.{test,spec}.{ts,tsx}',
  'packages/cli/src/test/**/*.{test,spec}.{ts,tsx}',
];

export default defineConfig({
  define: {
    __AGENFK_VERSION__: JSON.stringify('test'),
  },
  resolve: sharedResolve,
  test: {
    ...sharedTest({ include: [...PARALLEL_INCLUDE, ...SERIAL_INCLUDE] }),
    projects: [
      {
        test: {
          ...sharedTest({ include: PARALLEL_INCLUDE, parallel: true }),
          name: 'parallel',
        },
        resolve: sharedResolve,
      },
      {
        test: {
          ...sharedTest({ include: SERIAL_INCLUDE }),
          name: 'serial',
        },
        resolve: sharedResolve,
      },
    ],
  },
});
