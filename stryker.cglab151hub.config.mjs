// Scoped StrykerJS run for the hub half of CGLAB-151 — PR Overview: search by
// PR number, superseding every filter except Project.
//
// What is mutated, and why each file is in scope rather than decorative:
//
//  - `hub/src/queries/pr-overview-aggregate.ts` — `parsePrNumberFilter` (the
//    server-side grammar: 57, #57, a pasted GitHub / GitLab / Bitbucket PR URL)
//    and the rule that anything unparseable means "no filter", never "match
//    nothing"; plus the search predicate that SUPERSEDES from/to, models and
//    developers. A mutant that re-adds a superseded predicate is precisely the
//    defect the story exists to prevent, and a loosened `> 0` / safe-integer
//    guard turns `?pr=0` into the blank page the parser exists to avoid.
//  - `hub/src/routes/queries.ts` — the SQL upper bound that must be lifted for a
//    search and honoured without one, the previous-period delta that must be
//    skipped, the period the response reports, and the org + project predicates
//    that must NOT be dropped. One-condition changes, which is what mutation
//    testing is made for.
//
// Run through the HOME guard (never bare `npx stryker run`):
//   npm run test:stryker -- run stryker.cglab151hub.config.mjs
//
// If it ever looks stuck, check `sysctl vm.swapusage` and `memory_pressure -Q`
// BEFORE believing any theory about locks — see vitest.cglab151hub.config.ts for
// what actually stalled this branch (the OS reaping Stryker's test runners). And
// do not SIGKILL a run to investigate: Stryker cleans its sandbox only on a
// normal exit, and the next run copies the repo including the abandoned sandbox,
// nested. `rm -rf .stryker-tmp-*` if you must stop one.
export default {
  mutate: [
    'packages/hub/src/queries/pr-overview-aggregate.ts',
    'packages/hub/src/routes/queries.ts',
  ],
  testRunner: 'vitest',
  vitest: {
    configFile: 'vitest.cglab151hub.config.ts',
    // `related: true` — the route file contributes a few hundred mutants and
    // only a handful of specs touch it; forcing every spec against every mutant
    // would re-run the whole suite where coverage already says it is irrelevant.
    related: true,
  },
  reporters: ['clear-text', 'json'],
  jsonReporter: { fileName: 'reports/mutation/cglab151hub.json' },
  thresholds: { high: 80, low: 60, break: 0 },
  // Generous for a spec that boots an app (~0.6s), still 4x shorter than the
  // 120s default that turned every hanging mutant into a two-minute stall.
  timeoutMS: 30_000,
  // 2, not 3. Nothing in this suite shares the filesystem any more: the two
  // aggregate specs are pure functions and the route spec runs on an in-memory
  // database. It stays low because this box runs several agent sessions at once
  // and each worker is a full vitest process — see stryker.cglab151.config.mjs.
  concurrency: 2,
  // info, not warn — the verdict lines are the only honest progress signal, and
  // their absence is what made healthy long runs look like hangs.
  logLevel: 'info',
  // The single biggest speed lever: without this, ProjectReader walks ~44,000
  // files before a single mutant runs. With it, ~950. Also stops a leftover
  // sandbox from being copied into the next run's sandbox, nested.
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
  tempDirName: '.stryker-tmp-cglab151hub',
};
