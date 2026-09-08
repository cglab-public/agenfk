// Scoped StrykerJS config for CGLAB-138 (admin-settable private flow registry).
//
// Only the files this change touched are mutated, and each module is exercised
// by its own test file, so the run stays short enough to iterate on. The
// hub-ui validator is included because its whole point is agreeing with the
// server-side validator — a weakened comparison there is a real defect, not a
// cosmetic one.
//
// Run through the HOME guard (never bare `npx stryker run`):
//   npm run test:stryker -- run stryker.cglab138.config.mjs
export default {
  mutate: [
    'packages/hub/src/services/flowRegistry.ts',
    'packages/hub-ui/src/pages/adminFlowRegistry.ts',
  ],
  testRunner: 'vitest',
  vitest: {
    configFile: 'vitest.cglab138.config.ts',
    related: false,
  },
  reporters: ['clear-text', 'json', 'html'],
  jsonReporter: { fileName: 'reports/mutation/cglab138.json' },
  htmlReporter: { fileName: 'reports/mutation/cglab138.html' },
  thresholds: { high: 80, low: 60, break: 0 },
  timeoutMS: 120_000,
  concurrency: 1,
  logLevel: 'warn',
  tempDirName: '.stryker-tmp',
};
