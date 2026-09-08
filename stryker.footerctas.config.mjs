// Scoped StrykerJS run for the flow-editor footer CTA change (Publish is
// capability-gated, "Use this Flow" saves before it binds, one footer instead
// of two chosen by read-only-ness).
//
// Only the files this change touched are mutated. `FlowEditorModal.tsx` is the
// behaviour; `adminFlowRegistry.ts` carries the hub-admin labels, where a
// weakened comparison is a real defect (a label that collapses onto the other
// button's label is the confusion this change exists to remove).
//
// Run through the HOME guard (never bare `npx stryker run`):
//   npm run test:stryker -- run stryker.footerctas.config.mjs
export default {
  mutate: [
    'packages/flow-editor/src/FlowEditorModal.tsx',
    'packages/hub-ui/src/pages/adminFlowRegistry.ts',
  ],
  testRunner: 'vitest',
  vitest: {
    configFile: 'vitest.footerctas.config.ts',
    // `related: true` so each mutant runs only against the tests that cover it.
    // The CGLAB-138 config sets `related: false` because its mutated modules
    // are pure functions with one obvious spec each; that assumption does not
    // hold for a component file, and forcing every test against every mutant
    // produced a run where nothing registered as covered.
    related: true,
  },
  reporters: ['clear-text', 'json'],
  jsonReporter: { fileName: 'reports/mutation/footerctas.json' },
  thresholds: { high: 80, low: 60, break: 0 },
  timeoutMS: 120_000,
  concurrency: 1,
  logLevel: 'warn',
  tempDirName: '.stryker-tmp-footerctas',
};
