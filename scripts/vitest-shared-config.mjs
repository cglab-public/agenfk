/**
 * Shared vitest test config (single source of truth).
 *
 * The root `vitest.config.ts` and `vitest.workspace.ts` both consume this, so
 * timeouts, aliases, the HOME/bcrypt env pin, and the coverage gate can never
 * drift between a plain `vitest run` and a workspace/`--project` run.
 *
 * `fileParallelism: true` opts a project into running its FILES in separate
 * workers — see PARALLEL_INCLUDE in vitest.config.ts for which packages qualify
 * and why the rest must stay serial.
 *
 * There is deliberately no option for `sequence.concurrent`, which is a
 * different thing: concurrency of tests WITHIN one file. The two used to share
 * a single `parallel` flag, and that was a latent trap — the jsdom packages in
 * PARALLEL_INCLUDE are React component specs sharing one document, so running
 * their tests concurrently collides renders and fails 95 of them. File-level
 * parallelism is the win; within-file concurrency is the hazard. Keeping them
 * fused meant the safe half could not be turned on without the unsafe half.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { testEnv } from './vitest-home-pin.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const ALIAS = {
  '@agenfk/core': path.resolve(ROOT, './packages/core/src/index.ts'),
  '@agenfk/telemetry': path.resolve(ROOT, './packages/telemetry/src/index.ts'),
};

/**
 * @param {{ include: string[], environment?: string, fileParallelism?: boolean }} [opts]
 */
export function sharedTest(
  opts = {
    include: ['packages/*/src/test/**/*.{test,spec}.{ts,tsx}'],
  },
) {
  return {
    // HOME isolation (item 9c297075): pin every test worker to a per-run
    // sandbox home so no test can ever write into the real ~/.agenfk
    // (the 2026-08-31 hub.json clobber). Guarantees the JS-level
    // process.env.HOME sandbox for ALL workers (forks pool: normal runs +
    // CI — where libuv/os.homedir() follows it). Under Stryker's forced
    // threads pool the C environ is frozen in the runner's children on this
    // machine, so os.homedir() needs the spawn-time pin — always launch
    // Stryker via `npm run test:stryker` (scripts/stryker-home-wrap.mjs).
    // Stryker reuses this config for its vitest run.
    // AGENFK_HUB_BCRYPT_ROUNDS=4 also comes from here (see testEnv).
    env: testEnv(),
    globals: true,
    environment: opts.environment ?? 'node', // Use node for server/storage
    // Files that share filesystem state (sqlite DBs, install dirs) must run one
    // at a time; `fileParallelism: true` is only for the fs-free packages listed
    // in vitest.config.ts.
    fileParallelism: !!opts.fileParallelism,
    // Never concurrent within a file. Every package here has specs that mutate
    // shared per-file state — a jsdom document, a module mock, a temp dir — and
    // ordering between them is assumed. This is not a knob; it is a constraint.
    sequence: { concurrent: false },
    // Bumped above defaults (5s/10s) to absorb CPU contention when ~1100 tests
    // run serially: under load, bcrypt/AES-GCM in hub setup hooks and mocked
    // axios calls in upgrade-tier specs would otherwise trip the lower ceiling
    // on different files run-to-run, producing pseudo-random failures.
    testTimeout: 30000,
    hookTimeout: 30000,
    // Repairs `localStorage` for jsdom specs — Node's own undefined global
    // clobbers jsdom's. See vitest.setup.ts.
    setupFiles: ['./vitest.setup.ts'],
    include: opts.include,
    exclude: [
      '**/dist/**',
      '**/node_modules/**',
      'packages/ui/src/test/**',
      'packages/cli/src/test/cli.test.ts',
    ],
    coverage: {
      include: [
        'packages/core/src/**',
        'packages/storage-sqlite/src/**',
        'packages/server/src/**',
        'packages/hub/src/**',
      ],
      exclude: [
        '**/dist/**',
        '**/node_modules/**',
        'packages/server/src/index.ts',
        'packages/server/src/test-import.ts',
        'packages/server/src/test-import.js',
        'packages/server/src/bulk-updates.ts',
        'packages/hub/src/bin.ts',
      ],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
      reporter: ['text', 'json', 'html', 'json-summary'],
    },
  };
}

export const sharedResolve = { alias: ALIAS, root: ROOT };
