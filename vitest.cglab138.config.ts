import { defineConfig } from 'vitest/config';
import { sharedResolve, sharedTest } from './scripts/vitest-shared-config.mjs';

/**
 * Vitest config used ONLY by the scoped Stryker run for CGLAB-138
 * (stryker.cglab138.config.mjs). Narrows the suite to the tests that exercise
 * the two mutated modules, so each mutant costs one small run rather than the
 * whole serial suite.
 */
export default defineConfig({
  define: {
    __AGENFK_VERSION__: JSON.stringify('test'),
  },
  resolve: sharedResolve,
  test: {
    ...sharedTest({
      include: [
        'packages/hub/src/test/admin-flow-registry-config.test.ts',
        'packages/hub/src/test/flow-registry-service.test.ts',
        'packages/hub-ui/src/test/adminFlowRegistry.test.ts',
      ],
      // Serial. The three files are state-isolated — the hub app boots on an
      // injected ':memory:' sqlite handle (no tmpdir file, no WAL sidecars),
      // the service tests never boot a server, and the hub-ui tests are pure
      // functions — but concurrency still costs more than it saves here: each
      // hub boot runs bcrypt at the pinned cost on a synchronous path, and with
      // three workers competing the setup hook trips the 30s ceiling. Same
      // reason the rest of the hub suite is serial; the in-memory change
      // removed the filesystem sharing, not the CPU-bound hashing.
    }),
  },
});
