import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { testEnv } from '../../scripts/vitest-home-pin.mjs';

export default defineConfig({
  plugins: [react()],
  define: {
    __AGENFK_VERSION__: JSON.stringify('test'),
  },
  test: {
    // HOME isolation (item 9c297075) — defense in depth: the UI specs do no
    // home fs writes today, but a future one would land in the sandbox.
    env: testEnv(),
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    globals: true,
    /*
     * 20s, not the 5s default (CGLAB-164).
     *
     * The shell specs render the whole desktop cockpit into jsdom — sidebar,
     * tab strip, xterm panes, the board — and then drive it with `byRole`
     * queries, which recompute an accessible name for every candidate on every
     * `waitFor` poll. Several of them legitimately take 3-4 seconds on this
     * machine, and did so BEFORE this card: the two slowest sat at ~4.0s
     * against a 5s wall.
     *
     * That margin is a machine-speed lottery rather than a specification. Any
     * change that adds DOM to the sidebar — this one added three navigation
     * rows and a second line per card — moves a handful of unrelated specs
     * from 4.0s to 5.2s and they fail for a reason that has nothing to do with
     * what they assert. The ceiling is here to catch a genuinely hung test,
     * which is what a timeout is for; it is not a performance budget, and
     * using it as one only ever produces flakes.
     */
    testTimeout: 20_000,
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
