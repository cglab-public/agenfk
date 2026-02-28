import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  define: {
    __AGENFK_VERSION__: JSON.stringify('test'),
  },
  resolve: {
    alias: {
      '@agenfk/core': path.resolve(__dirname, './packages/core/src/index.ts'),
      '@agenfk/storage-json': path.resolve(__dirname, './packages/storage-json/src/index.ts'),
      '@agenfk/telemetry': path.resolve(__dirname, './packages/telemetry/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node', // Use node for server/storage
    resetMocks: true, // reset queued mockResolvedValueOnce/mockRejectedValueOnce between tests
    fileParallelism: false, // run test files serially to prevent filesystem state conflicts
    sequence: { concurrent: false }, // run tests within a file serially
    include: ['packages/*/src/test/**/*.{test,spec}.{ts,tsx}'],
    exclude: [
      '**/dist/**',
      '**/node_modules/**',
      'packages/ui/src/test/**',
      'packages/cli/src/test/cli.test.ts'
    ],
    coverage: {
      include: ['packages/core/src/**', 'packages/storage-json/src/**', 'packages/server/src/**'],
      exclude: [
        '**/dist/**',
        '**/node_modules/**',
        'packages/server/src/index.ts',
        'packages/server/src/test-import.ts',
        'packages/server/src/test-import.js',
        'packages/server/src/bulk-updates.ts',
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
