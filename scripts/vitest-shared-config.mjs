/**
 * Shared vitest test config (single source of truth).
 *
 * The root `vitest.config.ts` and `vitest.workspace.ts` both consume this, so
 * timeouts, aliases, the HOME/bcrypt env pin, and the coverage gate can never
 * drift between a plain `vitest run` and a workspace/`--project` run.
 *
 * `fileParallelism: true` opts a project into running its FILES in separate
 * workers — see vitest.config.ts for which packages run so, and the HOME per
 * worker (scripts/vitest-home-pin.mjs) that lets server/hub/cli (GH-274).
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
    // A project whose files share filesystem state across workers (sqlite DBs,
    // install dirs) must run them one at a time; every project in
    // vitest.config.ts opts in, the server/hub/cli ones on a HOME per worker.
    fileParallelism: !!opts.fileParallelism,
    // Never concurrent within a file. Every package here has specs that mutate
    // shared per-file state — a jsdom document, a module mock, a temp dir — and
    // ordering between them is assumed. This is not a knob; it is a constraint.
    sequence: { concurrent: false },
    // Bumped above defaults (5s/10s) to absorb CPU contention when ~1100 tests
    // run serially: under load, bcrypt/AES-GCM in hub setup hooks and mocked
    // axios calls in upgrade-tier specs would otherwise trip the lower ceiling
    // on different files run-to-run, producing pseudo-random failures.
    // Doubled on Windows (#208): every git call and child process there costs
    // several times what it does on POSIX, and the git-heavy server specs run
    // 20-25s alone - a loaded run pushed them over 30s. A hang still fails.
    testTimeout: process.platform === 'win32' ? 60000 : 30000,
    hookTimeout: process.platform === 'win32' ? 60000 : 30000,
    // Repairs `localStorage` for jsdom specs — Node's own undefined global
    // clobbers jsdom's. See vitest.setup.ts.
    setupFiles: ['./vitest.setup.ts'],
    // Deletes the HOME sandbox above once the run is over - with the server
    // suite's sqlite databases in it (scripts/vitest-sandbox-teardown.mjs).
    // Absolute: globalSetup resolves against the config's own root, and
    // packages/hub-ui runs this config from its package directory.
    globalSetup: [path.join(ROOT, 'scripts/vitest-sandbox-teardown.mjs')],
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
