import { defineWorkspace } from 'vitest/config';
import path from 'path';
import { testEnv } from './scripts/vitest-home-pin.mjs';

export default defineWorkspace([
  {
    resolve: {
      alias: {
        '@agenfk/core': path.resolve(__dirname, './packages/core/src/index.ts'),
      },
    },
    test: {
      name: 'agenfk',
      // Same HOME pin as the root config (item 9c297075) — memoized, so both
      // entries share one per-run sandbox.
      env: testEnv(),
      include: ['packages/*/src/test/**/*.{test,spec}.{ts,tsx}'],
      exclude: ['**/dist/**', '**/node_modules/**'],
      environment: 'jsdom',
    }
  }
]);
