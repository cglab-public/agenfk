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

/**
 * The temp dir spelled in full (#208). Windows hands out TEMP in 8.3 form
 * (`C:\Users\FABIOT~1\...`, `RUNNER~1` on CI) while git lists checkouts and
 * realpath.native resolves them by their long name, so a spec comparing a
 * temp path it built with one git or the server handed back sees two
 * spellings of one directory. Identity on POSIX.
 */
function longTmpdir() {
  try { return fs.realpathSync.native(os.tmpdir()); } catch { return os.tmpdir(); }
}
const TMP = longTmpdir();

let cached = null;

/**
 * Prefix of the per-run sandbox HOME directory.
 *
 * AGENFK_TEST_UNICODE_HOME=1 (set by the Windows CI job, issue #201) makes the
 * sandbox look like a real Windows user profile — a space plus non-ASCII
 * letters, as in `C:\Users\Fábio Teixeira` — so every code path that builds or
 * parses a path under HOME is exercised with the characters that actually broke
 * users, not just ASCII.
 */
export function testHomePrefix(env = process.env) {
  return env.AGENFK_TEST_UNICODE_HOME === '1' ? 'agenfk Fábio Téixeira ção-' : 'agenfk-test-home-';
}

/** Seed a sandbox HOME: the framework dir, its fixed verify-token, the test databases' dir (returned). */
function seedHome(home) {
  // Pre-seed the framework dir so code that reads verify-token / server-port
  // sees "absent", not a hostile foreign home.
  fs.mkdirSync(path.join(home, '.agenfk'), { recursive: true });
  /*
   * And seed a STABLE verify-token (BUG 9de0c99c).
   *
   * Leaving it absent was deliberate — "absent, not hostile" — but absent has
   * a cost that only shows up under load. The server computes VERIFY_TOKEN
   * once at module evaluation and, with no file to read, mints a RANDOM
   * ephemeral one. The server module is evaluated more than once in a run, so
   * a test holding the first token sends it to a route now comparing against
   * the second, and every token-gated call answers 401 — as a confident,
   * wrong statement about the route under test.
   *
   * Proof, from a failing run's own log: `[SERVER_START] Warning:
   * ~/.agenfk/verify-token not found ... Using ephemeral token` printed in
   * the middle of a test that then failed with `expected 401 to be 201`, on
   * `POST /items`, which has no token check of its own at all.
   *
   * A sandbox-owned fixed token is not a hostile foreign one: it lives in the
   * per-run sandbox and never touches the machine home. It only removes the
   * randomness, so however many times the module is evaluated, every instance
   * agrees.
   */
  fs.writeFileSync(path.join(home, '.agenfk', 'verify-token'), 'agenfk-test-verify-token');
  /*
   * And a place for the suite's sqlite databases (card c89e677d).
   *
   * The server tests resolved theirs against the cwd - the repository root -
   * and unlinked only the main file while the server's WAL connection was
   * open, so every run left its -wal/-shm sidecars at the root. Inside the
   * sandbox they go wherever the sandbox goes. Read through testDbPath()
   * (packages/server/src/test/helpers/testDb.ts).
   */
  const dbDir = path.join(home, 'test-dbs');
  fs.mkdirSync(dbDir, { recursive: true });
  return dbDir;
}

export function testHomeEnv() {
  if (!cached) {
    const home = fs.mkdtempSync(path.join(TMP, testHomePrefix()));
    const dbDir = seedHome(home);
    cached = {
      HOME: home,
      USERPROFILE: home, // Windows parity; harmless on POSIX
      // os.tmpdir() reads these on Windows; on POSIX TMPDIR stays as it was.
      ...(process.platform === 'win32' ? { TEMP: TMP, TMP } : {}),
      AGENFK_REAL_HOME: REAL_HOME,
      AGENFK_TEST_DB_DIR: dbDir,
      // What each worker takes its own home inside (pinWorkerHome): HOME itself is re-pointed there.
      AGENFK_TEST_RUN_HOME: home,
    };
  }
  return cached;
}

/**
 * The home of one vitest worker (GH-274): `worker-<poolId>` inside the run's
 * sandbox, seeded like the sandbox itself. The same directory every time for
 * the same worker, so the files a worker runs one after another share it
 * exactly as every file of the run used to share the sandbox.
 */
export function workerHomeEnv(runHome, poolId) {
  const home = path.join(runHome, `worker-${poolId}`);
  const dbDir = seedHome(home);
  return { HOME: home, USERPROFILE: home, AGENFK_TEST_DB_DIR: dbDir };
}

/**
 * Re-point a vitest worker at its own home (GH-274), from the setup file that
 * runs before each test file. The server, hub and cli files used to run one at
 * a time because every worker shared the run's HOME - its databases, its
 * ~/.agenfk, whatever a spec writes under it; with a home per worker they run
 * beside each other. The sandbox teardown still removes them all with the run's.
 *
 * Applied only where os.homedir() follows HOME (`homedir`, after the change).
 * Under a frozen C environ (a threads pool on Node >= 24, see the header) the
 * worker would read one home through process.env and write another through
 * os.homedir(), so the run's home is put back - and that is safe only for the
 * Stryker guard's runs (AGENFK_SPAWN_PIN), which run one worker and check the
 * real home afterwards. Anywhere else the workers would share one HOME while
 * running files in parallel, so it throws instead of letting them collide.
 * Returns whether the worker now has its own home.
 */
export function pinWorkerHome(env = process.env, homedir = os.homedir) {
  const runHome = env.AGENFK_TEST_RUN_HOME;
  const poolId = env.VITEST_POOL_ID;
  if (!runHome || !poolId) return false;
  const before = { HOME: env.HOME, USERPROFILE: env.USERPROFILE, AGENFK_TEST_DB_DIR: env.AGENFK_TEST_DB_DIR };
  const own = workerHomeEnv(runHome, poolId);
  Object.assign(env, own);
  if (homedir() === own.HOME) return true;
  for (const [k, v] of Object.entries(before)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  if (env.AGENFK_SPAWN_PIN === '1') return false;
  throw new Error(
    'os.homedir() does not follow HOME in this vitest worker (a frozen C environ: the threads pool on Node >= 24), '
    + 'so it cannot have a HOME of its own, and the server/hub/cli files would share one while running in parallel. '
    + 'Run in the forks pool (the default), or launch Stryker through `npm run test:stryker`.',
  );
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
  return {
    ...testHomeEnv(),
    AGENFK_HUB_BCRYPT_ROUNDS: '4',
    /*
     * Cleared, not inherited (BUG 6b3e7a98).
     *
     * `server.ts` mounts the static UI at MODULE level when this is set, so a
     * suite that inherits it gets a different Express app than the one the
     * tests were written against — `GET /` answers a page instead of the API's
     * JSON, and assertions about API-only behaviour fail.
     *
     * It is inherited exactly when the suite is run BY the framework: `agenfk
     * verify` spawns the command from the server, and the server was itself
     * launched by the desktop app, which sets this to the bundle inside the
     * .app. So the suite passed from a shell and failed from the tool — and
     * which assertions broke depended on which files were in the run, which
     * reads as "a different test every time".
     *
     * The eleven hypotheses this bug went through all looked for state shared
     * BETWEEN tests. There is none. The shared state was the environment the
     * tests were launched from.
     *
     * An empty string is falsy, so the module-level mount stays off. The one
     * suite that needs the UI mounted calls `mountStaticUI` itself.
     */
    AGENFK_SERVE_UI: '',
  };
}
