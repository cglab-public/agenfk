import { defineConfig } from 'vitest/config';
import { sharedResolve, sharedTest } from './scripts/vitest-shared-config.mjs';

/**
 * Vitest config used ONLY by the scoped Stryker run for the pi extension
 * (stryker.pi-extension.config.mjs). It narrows the suite to the one test file
 * that exercises bin/agenfk-pi-extension.ts, so mutation testing stays a
 * seconds-long job instead of running the whole serial suite per mutant.
 */
export default defineConfig({
  define: {
    __AGENFK_VERSION__: JSON.stringify('test'),
  },
  resolve: sharedResolve,
  test: {
    ...sharedTest({ include: ['packages/server/src/test/pi-extension.test.ts'], parallel: true }),
  },
});
