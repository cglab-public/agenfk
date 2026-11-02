import * as os from 'os';
import { defineConfig } from 'vitest/config';
import { sharedResolve, sharedTest } from './scripts/vitest-shared-config.mjs';

/**
 * Test files that touch no shared filesystem state, so their files may run
 * concurrently instead of one-at-a-time.
 *
 * Every project here ran one file at a time once, because tests share
 * filesystem state (sqlite DBs, install dirs) and every worker was pinned to a
 * single per-run HOME sandbox (scripts/vitest-home-pin.mjs). These packages
 * never needed that - pure logic, or a mocked `os.homedir()` per file - and
 * were the first moved out; server/hub/cli followed with a HOME per worker
 * (GH-274, below). These packages qualify:
 *   - core: workflow/flow/semver/gatekeeper logic, zero fs access
 *   - hub-ui, flow-editor: jsdom component specs (the board, packages/ui, is
 *     its own project below)
 *   - storage-sqlite, telemetry: fs-touching, but each file uses its own
 *     mkdtemp dir or a mocked `os.homedir()`, so there is no cross-file
 *     contention
 * Anything under packages/server, packages/hub or packages/cli is in the
 * project below instead.
 */
const PARALLEL_INCLUDE = [
  'packages/core/src/test/**/*.{test,spec}.{ts,tsx}',
  'packages/storage-sqlite/src/test/**/*.{test,spec}.{ts,tsx}',
  'packages/telemetry/src/test/**/*.{test,spec}.{ts,tsx}',
  'packages/hub-ui/src/test/**/*.{test,spec}.{ts,tsx}',
  'packages/flow-editor/src/test/**/*.{test,spec}.{ts,tsx}',
  'packages/desktop/src/test/**/*.{test,spec}.{ts,tsx}',
  // The TDD harness's pure logic; the harness itself runs in Docker (npm run e2e:tdd).
  'e2e/tdd-harness/test/**/*.{test,spec}.{ts,tsx}',
];

/**
 * The server, hub and cli files (GH-274) - the project is still named
 * `serial` for what it was. They write under HOME - sqlite databases,
 * ~/.agenfk, install dirs - and ran one at a time while every worker shared the
 * run's HOME sandbox; each worker now has a home of its own (pinWorkerHome in
 * scripts/vitest-home-pin.mjs), so they run in parallel with everything else.
 */
const SERIAL_TIMEOUT = (process.platform === 'win32' ? 60_000 : 30_000) * 2;
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
    // NOTE the fileParallelism here. This root-level block is what vitest uses
    // as the global, and the global WINS over a project's own value — which is
    // why PARALLEL_INCLUDE below was inert for as long as this said false:
    // both projects resolved their settings correctly and then ran serially
    // anyway. Leaving it permissive lets each project decide; a project that
    // must run one file at a time says `fileParallelism: false` itself (none
    // does since GH-274).
    ...sharedTest({ include: [...PARALLEL_INCLUDE, ...SERIAL_INCLUDE], fileParallelism: true }),
    /*
     * A quarter of the CPUs (at least 2), not vitest's all-but-one (GH-274).
     * A server, hub or cli file spawns git and node children by the dozen, so a
     * worker is several CPUs' load. Measured on an 18-CPU machine: at 9 workers
     * every test ran ~3.9x slower than alone (6996s of test time in an 817s run)
     * and the heaviest end-to-end tests passed 60s; at 4 workers the server files
     * ran ~1.35x slower than alone, all green. Set here, at the root, so
     * `--maxWorkers` on the command line still overrides it for every project; a
     * project's own value would win over the flag.
     */
    maxWorkers: Math.max(2, Math.floor(os.availableParallelism() / 4)),
    projects: [
      {
        test: {
          ...sharedTest({ include: PARALLEL_INCLUDE, fileParallelism: true }),
          name: 'parallel',
        },
        resolve: sharedResolve,
      },
      {
        test: {
          ...sharedTest({ include: SERIAL_INCLUDE, fileParallelism: true }),
          name: 'serial',
          // Twice the shared ceiling (GH-274): these files' end-to-end tests walk cards
          // through real verifies - dozens of git and node children each - and now run
          // beside other workers doing the same, so one that took 17s alone took 31s
          // with four files at once. The ceiling catches a hang; it is not a budget.
          testTimeout: SERIAL_TIMEOUT,
          hookTimeout: SERIAL_TIMEOUT,
        },
        resolve: sharedResolve,
      },
      // The board (4ac25844), under its OWN config: jsdom, the react plugin,
      // its setup file and timeout - under the shared node settings its specs
      // fail in the hundreds. It used to run only from `cd packages/ui`, so the
      // project's verify command and test report - every agenfk gate's view of
      // the suite - never saw a board spec, and a card could break one and pass.
      'packages/ui/vitest.config.ts',
    ],
  },
});
