import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { testEnv } from './scripts/vitest-home-pin.mjs';

/**
 * Vitest config for the scoped Stryker run over the flow-editor footer CTA
 * change (Publish capability-gating, save-before-bind, single footer).
 * Narrows the suite to the specs that exercise the mutated modules.
 */
export default defineConfig({
  plugins: [react()],
  define: { __AGENFK_VERSION__: JSON.stringify('test') },
  test: {
    env: testEnv(),
    environment: 'jsdom',
    setupFiles: ['./packages/ui/src/test/setup.ts'],
    globals: true,
    include: [
      'packages/ui/src/test/FlowEditorModal.test.tsx',
      'packages/hub-ui/src/test/adminFlowRegistry.test.ts',
      // The wiring spec that proves the hub captions reach the button and that
      // Publish is absent. Without it in this list the label mutants are not
      // exercised at all by this config, and the killcheck reports them as
      // survivors — a hole in the harness reading as a hole in the tests.
      'packages/hub-ui/src/test/adminFlowsEditor.test.tsx',
    ],
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
