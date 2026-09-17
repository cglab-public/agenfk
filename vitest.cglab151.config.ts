import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { sharedResolve } from './scripts/vitest-shared-config.mjs';
import { testEnv } from './scripts/vitest-home-pin.mjs';

/**
 * Vitest config used ONLY by the scoped Stryker run for CGLAB-151
 * (stryker.cglab151.config.mjs — PR Overview: search by PR number).
 *
 * hub-ui half only. The hub half has its own pair (stryker.cglab151hub.config.mjs
 * + vitest.cglab151hub.config.ts) and the split is not tidiness: one Stryker run
 * cannot serve both, because the hub specs boot express on file-backed sqlite
 * while these run under jsdom with the React plugin. Mixed, the initial dry run
 * never finished.
 *
 * The suite is narrowed to the specs that exercise the mutated modules, so each
 * mutant costs one small run instead of the whole serial suite. Every pre-existing
 * PR Overview spec is in here on purpose: `PrOverview.tsx` is mutated whole, so a
 * mutant in the heatmap code the search sits inside needs its original spec in
 * the run — otherwise it reports as a survivor and the harness reads as a hole.
 */
export default defineConfig({
  plugins: [react()],
  define: { __AGENFK_VERSION__: JSON.stringify('test') },
  resolve: sharedResolve,
  test: {
    env: testEnv(),
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: [
      'packages/hub-ui/src/test/prSearch.test.ts',
      'packages/hub-ui/src/test/prOverviewSearch.test.tsx',
      'packages/hub-ui/src/test/prOverview.test.ts',
      'packages/hub-ui/src/test/prOverviewPage.test.tsx',
      'packages/hub-ui/src/test/prOverviewFilters.test.tsx',
      'packages/hub-ui/src/test/prOverviewDrilldown.test.tsx',
      'packages/hub-ui/src/test/prPerDay.test.ts',
      'packages/hub-ui/src/test/prVolumeGranularity.test.ts',
      'packages/hub-ui/src/test/facetSearch.test.ts',
      'packages/hub-ui/src/test/facetMultiselectDisabled.test.tsx',
      'packages/hub-ui/src/test/useToggleSet.test.ts',
    ],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
