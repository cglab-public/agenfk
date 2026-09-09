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
 * Both cover the route. Only one of them can drive a mutant phase. A hub spec
 * booted on a FILE-backed sqlite database finishes Stryker's dry run and then
 * returns zero verdicts at 0% CPU, indefinitely, and it took three wrong
 * diagnoses to find out why (see the full write-up at the top of the route spec):
 *
 *   - `openSqliteDb` runs on `node:sqlite`'s synchronous DatabaseSync with WAL
 *     on for any file path — a blocked statement parks the entire thread;
 *   - the hub tests key their DB file on `process.pid`, and worker threads share
 *     the parent's pid (verified: main pid=22501/threadId=0, worker
 *     pid=22501/threadId=1), so every worker computes the same path;
 *   - Stryker's vitest runner forces `pool: 'threads'`.
 *
 * So the dry run and the mutant runs contend on one WAL database inside one
 * process. The route spec uses `openSqliteDb(':memory:')` — private per
 * connection, nothing to contend on — and the mutant phase runs.
 *
 * That is a repo-level trap, not a CGLAB-151 one: it is also why `npm test` runs
 * with file parallelism off. Making the pid-keyed paths unique (or `:memory:`)
 * across the hub suite is worth its own story.
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
