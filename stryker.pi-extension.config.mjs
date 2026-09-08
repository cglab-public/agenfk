// Scoped StrykerJS config for the pi extension model-detection change.
// Only the file this bug touched is mutated; vitest's own include filter keeps the
// run to the test file that exercises it.
export default {
  mutate: ['bin/agenfk-pi-extension.ts'],
  testRunner: 'vitest',
  vitest: {
    configFile: 'vitest.pi-extension.config.ts',
    related: false,
  },
  reporters: ['clear-text', 'json', 'html'],
  jsonReporter: { fileName: 'reports/mutation/pi-extension.json' },
  htmlReporter: { fileName: 'reports/mutation/pi-extension.html' },
  thresholds: { high: 80, low: 60, break: 0 },
  timeoutMS: 60_000,
  concurrency: 1,
  logLevel: 'warn',
  tempDirName: '.stryker-tmp',
};
