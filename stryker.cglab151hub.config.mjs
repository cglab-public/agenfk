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
// If it ever looks stuck, read vitest.cglab151hub.config.ts first — the last time
// this looked hung it was a shared WAL file, not a hang. And do not SIGKILL a
// run to find out: Stryker only cleans its sandbox on a normal exit, and the next
// run copies the repo including the abandoned sandbox, nested, until file
// discovery really does wedge. `rm -rf .stryker-tmp-*` if you must stop one.
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
  // 3, not 1. Nothing in this suite shares the filesystem any more: the two
  // aggregate specs are pure functions and the route spec runs on an in-memory
  // database. It stays below the hub-ui run's 4 because a mutant that does reach
  // the DB costs more, and oversubscribing makes that worse.
  concurrency: 3,
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
