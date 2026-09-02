import { defineConfig } from 'vitest/config';
import path from 'path';
import { testHomeEnv } from './scripts/vitest-home-pin.mjs';

export default defineConfig({
  define: {
    __AGENFK_VERSION__: JSON.stringify('test'),
  },
  resolve: {
    alias: {
      '@agenfk/core': path.resolve(__dirname, './packages/core/src/index.ts'),
      '@agenfk/telemetry': path.resolve(__dirname, './packages/telemetry/src/index.ts'),
    },
  },
  test: {
    // HOME isolation (item 9c297075): pin every test worker to a per-run
    // sandbox home so no test can ever write into the real ~/.agenfk
    // (the 2026-08-31 hub.json clobber). Applies to Stryker runs too —
    // they reuse this config.
    env: testHomeEnv(),
    globals: true,
    environment: 'node', // Use node for server/storage
    resetMocks: true, // reset queued mockResolvedValueOnce/mockRejectedValueOnce between tests
    fileParallelism: false, // run test files serially to prevent filesystem state conflicts
    sequence: { concurrent: false }, // run tests within a file serially
    // Bumped above defaults (5s/10s) to absorb CPU contention when ~1100 tests
    // run serially: under load, bcrypt/AES-GCM in hub setup hooks and mocked
    // axios calls in upgrade-tier specs would otherwise trip the lower ceiling
    // on different files run-to-run, producing pseudo-random failures.
    testTimeout: 30000,
    hookTimeout: 30000,
    // Repairs `localStorage` for jsdom specs — Node's own undefined global
    // clobbers jsdom's. See vitest.setup.ts.
    setupFiles: ['./vitest.setup.ts'],
    include: ['packages/*/src/test/**/*.{test,spec}.{ts,tsx}'],
    exclude: [
      '**/dist/**',
      '**/node_modules/**',
      'packages/ui/src/test/**',
      'packages/cli/src/test/cli.test.ts'
    ],
    coverage: {
      include: ['packages/core/src/**', 'packages/storage-sqlite/src/**', 'packages/server/src/**', 'packages/hub/src/**'],
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
  },
});
