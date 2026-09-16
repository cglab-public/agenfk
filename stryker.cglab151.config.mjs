// Scoped StrykerJS run for the hub-ui half of CGLAB-151 — PR Overview: search by
// PR number, superseding every filter except Project.
//
// What is mutated, and why each file is in scope rather than decorative:
//
//  - `hub-ui/src/prSearch.ts` — new. The whole feature's gate: what counts as a
//    PR search. A weakened comparison here (dropping `> 0`, the safe-integer cap,
//    or the trim) turns a half-typed box into a search that matches nothing, or a
//    pasted URL into garbage.
//  - `hub-ui/src/pages/PrOverview.tsx` — the query-shape branch (a search sends
//    `projects` + `pr` and NOTHING else), the `?pr=` URL round-trip, the axis
//    built from the matched days, the active-filter badge, the empty state, and
//    which controls are disabled.
//  - `hub-ui/src/components/FacetMultiselect.tsx` / `ModelMetaFilter.tsx` — the
//    new `disabled` wiring. A dropped `disabled` is a control that looks live
//    while its selection changes nothing; a popover that stays open over inert
//    options is a keyboard trap.
//
// The hub half is a separate run (stryker.cglab151hub.config.mjs): different
// environment, different specs, and one Stryker run cannot serve both.
//
// Run through the HOME guard (never bare `npx stryker run`):
//   npm run test:stryker -- run stryker.cglab151.config.mjs
export default {
  mutate: [
    'packages/hub-ui/src/prSearch.ts',
    'packages/hub-ui/src/pages/PrOverview.tsx',
    'packages/hub-ui/src/components/FacetMultiselect.tsx',
    'packages/hub-ui/src/components/ModelMetaFilter.tsx',
  ],
  testRunner: 'vitest',
  vitest: {
    configFile: 'vitest.cglab151.config.ts',
    // `related: true` — three of these are components, and forcing every spec
    // against every mutant produces a run where nothing registers as covered
    // (same finding as stryker.footerctas.config.mjs).
    related: true,
  },
  reporters: ['clear-text', 'json'],
  jsonReporter: { fileName: 'reports/mutation/cglab151.json' },
  thresholds: { high: 80, low: 60, break: 0 },
  // A mutant that hangs an 827-line component used to cost 120s of dead waiting;
  // these specs run in well under a second, so 30s is already generous.
  timeoutMS: 30_000,
  // 2, not 4. These four specs are jsdom-only — no DB, no tmpdir, no
  // process.env (verified) — so there is no shared filesystem state to race on,
  // which is the only reason the hub run stays serial. But this machine carries
  // several agent sessions at once and swap was nearly full when a 4-worker run
  // here got its test runners reaped mid-sweep. Concurrency is memory budget,
  // not speed preference.
  concurrency: 2,
  // info, not warn: the per-mutant verdict lines are the only honest progress
  // signal this tool gives, and their absence is what made a healthy 15-minute
  // run look like a hang.
  logLevel: 'info',
  // Never copy a previous sandbox into the next one. A SIGKILL'd run leaves its
  // sandbox behind (Stryker cleans up only on a normal exit), and the next run
  // then copies it — nested, recursively, gigabytes deep — which really does
  // wedge file discovery.
  ignorePatterns: [
    '.stryker-tmp-*',
    '.git',
    'reports',
    '.reports',
    '.pi',
    '*.sqlite',
    '*.sqlite-wal',
    '*.sqlite-shm',
    'coverage',
  ],
  tempDirName: '.stryker-tmp-cglab151',
};
