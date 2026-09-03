import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { testHomeEnv } from '../../scripts/vitest-home-pin.mjs';

export default defineConfig({
  plugins: [react()],
  define: {
    __AGENFK_VERSION__: JSON.stringify('test'),
  },
  test: {
    // HOME isolation (item 9c297075) — defense in depth: the UI specs do no
    // home fs writes today, but a future one would land in the sandbox.
    env: testHomeEnv(),
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    globals: true,
    coverage: {
      include: ['./src/**'],
      exclude: [
        './src/test/**',
        './src/main.tsx',
        './src/types.ts',
        './src/queryClient.ts',
        './src/assets/**',
        './src/**/*.css',
        './src/**/*.svg',
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
