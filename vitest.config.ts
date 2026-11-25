import * as os from 'os';
import { defineConfig } from 'vitest/config';
import { sharedResolve, sharedTest } from './scripts/vitest-shared-config.mjs';
import { resolveMaxWorkers } from './scripts/vitest-workers.mjs';

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

/*
 * The root `test` block holds ONLY the run-wide options, never a project's.
 *
 * vitest 5 merges this block into every inline project below (they have no
 * `extends: false`), and arrays concatenate: a root `include` of both lists
 * made `parallel` and `serial` each collect every file, so the whole non-board
 * suite ran twice, once per project. A root `define` or `setupFiles` would
 * leak the same way (a root `__AGENFK_VERSION__: 'test'` broke airlock-exec's
 * version check). Each project brings its own `sharedTest(...)`; the board
 * brings its own config file. core's vitestParallelism.test.ts guards both.
 */
const { coverage } = sharedTest();

export default defineConfig({
  resolve: sharedResolve,
  test: {
    // NOTE the fileParallelism here. This root-level block is what vitest uses
    // as the global, and the global WINS over a project's own value — which is
    // why PARALLEL_INCLUDE below was inert for as long as this said false:
    // both projects resolved their settings correctly and then ran serially
    // anyway. Leaving it permissive lets each project decide; a project that
    // must run one file at a time says `fileParallelism: false` itself (none
    // does since GH-274).
    fileParallelism: true,
    // Never concurrent within a file, run-wide (see scripts/vitest-shared-config.mjs).
    sequence: { concurrent: false },
    // Coverage is run-wide in vitest: only the root's settings apply.
    coverage,
    /*
     * The worker count, not vitest's all-but-one: scripts/vitest-workers.mjs.
     *
     * POSIX - a quarter of the CPUs, at least 2 (GH-274). A server, hub or cli
     * file spawns git and node children by the dozen, so a worker is several
     * CPUs' load and CPU is the bottleneck. Measured on an 18-CPU Linux machine:
     * at 9 workers every test ran ~3.9x slower than alone (6996s of test time in
     * an 817s run) and the heaviest end-to-end tests passed 60s; at 4 workers the
     * server files ran ~1.35x slower than alone, all green.
     *
     * win32 - 40% of the CPUs, rounded, at most 8, never fewer than POSIX (#313).
     * There the same files are wait-bound, not CPU-bound: each spawn waits on
     * process creation and on the EDR sensor scanning it, so more workers overlap
     * that wait instead of fighting for CPU. Measured on a 14-CPU Windows 11
     * machine, 8-file server subset, pre-change code, all green:
     *
     *   | maxWorkers | Duration |
     *   |      3     | 384.6 s  |   (the POSIX rule)
     *   |      4     | 314.7 s  |
     *   |      6     | 277.0 s  |   (the win32 rule at 14 CPUs)
     *   |      8     | 284.0 s  |
     *
     * Set here, at the root: the inline projects inherit it. The board's own
     * config file resolves the same value, because vitest 5 refuses projects
     * of one sequence.groupOrder whose maxWorkers differ. `--maxWorkers` on the
     * command line overrides it for every project.
     */
    maxWorkers: resolveMaxWorkers({ platform: process.platform, cpus: os.availableParallelism() }),
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
      // It resolves the same maxWorkers as the root itself (see that file).
      'packages/ui/vitest.config.ts',
    ],
  },
});
