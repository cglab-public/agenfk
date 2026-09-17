import { defineConfig } from 'vitest/config';
import { sharedResolve, sharedTest } from './scripts/vitest-shared-config.mjs';

/**
 * Vitest config used ONLY by the scoped Stryker run for the hub half of
 * CGLAB-151 (stryker.cglab151hub.config.mjs — PR Overview: search by PR number).
 *
 * The hub half lives apart from the hub-ui half (vitest.cglab151.config.ts)
 * because these are node specs and those run under jsdom with the React plugin;
 * one Stryker run cannot serve both.
 *
 * WHY `pr-overview-pr-search-route.test.ts` AND NOT `queries.test.ts`
 *
 * Both cover the route. The route spec is used here because it is cheap and
 * self-contained: it boots the app on `openSqliteDb(':memory:')` rather than the
 * file-backed path queries.test.ts uses, so it runs in ~0.6s and shares no
 * filesystem state.
 *
 * That swap also removes a genuine trap — though it turned out NOT to be what
 * stalled this branch's sweeps, so it is recorded as a hazard, not as the fix:
 * `openSqliteDb` runs on `node:sqlite`'s synchronous DatabaseSync with WAL on for
 * any file path (a blocked statement parks the whole thread); hub tests key their
 * DB file on `process.pid`; worker threads SHARE the parent's pid (verified: main
 * pid=22501/threadId=0, worker pid=22501/threadId=1); and Stryker's vitest runner
 * forces `pool: 'threads'`. File-backed hub specs therefore do contend on one WAL
 * database across threads of one process. `:memory:` is private per connection, so
 * this spec cannot contend. Making the pid-keyed paths unique repo-wide is worth
 * its own story — it is also why `npm test` runs with file parallelism off.
 *
 * WHAT REALLY STALLED THE SWEEPS: memory pressure, three times. Check this before
 * diagnosing any stall as a lock. The system log of one dead run is unambiguous —
 * Stryker created 4 test-runner processes, the dry run succeeded, and two seconds
 * later the box reported critical memory pressure. The workers were reaped and
 * Stryker's main process waited forever for verdicts from processes that no longer
 * existed. Signature: main alive at 0% CPU, no vitest children, no sandbox writes,
 * zero verdicts, and a leftover `.stryker-tmp-*` (a clean exit removes it). Look at
 * `sysctl vm.swapusage` and `memory_pressure -Q` FIRST. This box runs several
 * agent sessions at once, so keep `concurrency` low — that is not a tuning
 * preference, it is what stops the sweep being killed mid-flight.
 */
export default defineConfig({
  define: { __AGENFK_VERSION__: JSON.stringify('test') },
  resolve: sharedResolve,
  test: sharedTest({
    include: [
      'packages/hub/src/test/pr-overview-pr-search.test.ts',
      'packages/hub/src/test/pr-overview-aggregate.test.ts',
      'packages/hub/src/test/pr-overview-pr-search-route.test.ts',
    ],
  }),
});
