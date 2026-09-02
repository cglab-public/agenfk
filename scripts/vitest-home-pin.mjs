/**
 * HOME isolation for test runs (item 9c297075).
 *
 * The 2026-08-31 clobber incident: a Stryker mutation run executed hub tests
 * whose HOME sandboxing did not apply under the runner, so a test fixture
 * `hub.json` was written into the REAL ~/.agenfk — twice. The structural fix:
 * every vitest worker (normal runs AND Stryker, which reuses this config)
 * starts with HOME pinned to a per-run sandbox, so a test that forgets to
 * sandbox writes into the sandbox, never the machine home.
 *
 * The original home is exposed as AGENFK_REAL_HOME for the tests that verify
 * the pin itself (packages/server/src/test/home-isolation.test.ts).
 *
 * Memoized per process: the root vitest config and the workspace project both
 * import this module in one process and must share the SAME sandbox.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REAL_HOME = process.env.HOME || os.homedir();

let cached = null;

export function testHomeEnv() {
  if (!cached) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-test-home-'));
    // Pre-seed the framework dir so code that reads verify-token / server-port
    // sees "absent", not a hostile foreign home.
    fs.mkdirSync(path.join(home, '.agenfk'), { recursive: true });
    cached = {
      HOME: home,
      USERPROFILE: home, // Windows parity; harmless on POSIX
      AGENFK_REAL_HOME: REAL_HOME,
    };
  }
  return cached;
}
