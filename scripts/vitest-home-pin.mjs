/**
 * HOME isolation for test runs (item 9c297075).
 *
 * The 2026-08-31 clobber incident: a Stryker mutation run executed hub tests
 * whose HOME sandboxing did not apply under the runner, so a test fixture
 * `hub.json` was written into the REAL ~/.agenfk — twice. The structural fix:
 * every vitest worker starts with process.env.HOME pinned to a per-run
 * sandbox, so a test that forgets to sandbox writes into the sandbox, never
 * the machine home. This pin guarantees the JS-level process.env.HOME value
 * in every runner. On POSIX, os.homedir() (libuv) follows it wherever the
 * process's C environ is live — normal vitest runs (forks pool) and CI.
 *
 * KNOWN LIMITATION (this machine, Node >= 24): Stryker's vitest runner
 * forces pool 'threads', and its child processes keep a FROZEN C environ —
 * process.env mutations inside the process never reach libuv there. For
 * Stryker runs the pin must therefore be applied at SPAWN time: use
 * `npm run test:stryker` (scripts/stryker-home-wrap.mjs), which bakes the
 * sandbox HOME into every child's C environ and wraps the run with the
 * home-integrity sentinel.
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

/**
 * Test-time env shared by every runner (vitest root config, workspace project,
 * and the Stryker spawn-time wrap).
 *
 * AGENFK_HUB_BCRYPT_ROUNDS: the hub's `hashSync`/`compareSync` are synchronous
 * and the hub suite performs ~238 of them. At the production cost of 11 that is
 * ~23s of blocked worker per full run for zero extra signal — the bcrypt hash
 * format is identical at cost 4, so login/signup/rotation paths are still
 * exercised end to end. Production never sets this var, so it keeps rounds 11.
 * Set via env only: `hashPassword` takes no cost argument, so no test can
 * weaken a real login path.
 */
export function testEnv() {
  return { ...testHomeEnv(), AGENFK_HUB_BCRYPT_ROUNDS: '4' };
}
