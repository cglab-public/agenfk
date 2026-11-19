/**
 * HOME isolation — the 2026-08-31 / 2026-09-01 clobber incident (item 9c297075).
 *
 * StrykerJS mutation runs wrote test-fixture hub.json values into the REAL
 * ~/.agenfk twice: once losing 57 hub events (WAL-recovered), once destroying
 * the real hub credentials (token rotated; re-login never happened). A third
 * hit surfaced 2026-09-02 during this item's own mutation pass: under the
 * Stryker child-process runner, a process.env.HOME mutation does not reach
 * libuv on this machine (os.homedir() kept returning the machine home), so a
 * test that writes through a HOME-derived path deleted the LIVE
 * ~/.agenfk/server-port file.
 *
 * Structural fixes verified here:
 *  1. Hub/telemetry home paths resolve at CALL time, not import time —
 *     proven by swapping os.homedir() (the single source the getters read)
 *     for a sandbox per test. The homedir mock — rather than an env override —
 *     is what makes this verification environment-independent: the getters
 *     must track whatever os.homedir() returns at call time, in every runner.
 *  2. The vitest runner pins process.env.HOME to a per-run sandbox
 *     (see vitest.config.ts / scripts/vitest-home-pin.mjs) — a JS-level
 *     guarantee for every worker. Under the forks pool (normal runs, CI)
 *     libuv/os.homedir() follows it (asserted below); under Stryker's forced
 *     threads pool the C environ is frozen on this machine, so Stryker must
 *     be launched via `npm run test:stryker` (spawn-time pin + sentinel) —
 *     also asserted below, via the AGENFK_SPAWN_PIN marker.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { hubConfigPath } from '../hub/hubClient';
import { defaultDeadletterPath } from '../hub/flusher';
import { agenfkDir } from '@agenfk/telemetry';

// Mockable homedir: delegates to the real one unless a test re-points it.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: vi.fn(() => actual.homedir()) };
});

// Set by the vitest config BEFORE the HOME pin — the machine's real home.
const REAL_HOME = process.env.AGENFK_REAL_HOME;

describe('home isolation (item 9c297075)', () => {
  it('the vitest runner pins HOME to a per-run sandbox, not the machine home', () => {
    expect(REAL_HOME, 'AGENFK_REAL_HOME unset — the vitest HOME pin is missing').toBeTruthy();
    expect(process.env.HOME).toBeTruthy();
    expect(process.env.HOME, 'test HOME must differ from the real home').not.toBe(REAL_HOME);
    // The sandbox is pre-seeded with the framework dir so code that reads
    // verify-token/server-port gets "absent", not "hostile".
    expect(fs.existsSync(path.join(process.env.HOME!, '.agenfk'))).toBe(true);
  });

  // GH-274: the server, hub and cli files run beside each other, so a worker's HOME is its own.
  it("this worker's HOME is its own directory inside the run's sandbox, with its own test databases", () => {
    const run = process.env.AGENFK_TEST_RUN_HOME;
    expect(run, 'AGENFK_TEST_RUN_HOME unset: the run sandbox is not named for the workers').toBeTruthy();
    expect(process.env.VITEST_POOL_ID).toBeTruthy();
    // Under a frozen C environ (Stryker's threads) the worker keeps the run's home: see pinWorkerHome.
    if (process.env.AGENFK_SPAWN_PIN === '1' && os.homedir() === run) return;
    expect(process.env.HOME).toBe(path.join(run!, `worker-${process.env.VITEST_POOL_ID}`));
    expect(os.homedir()).toBe(process.env.HOME);
    expect(process.env.AGENFK_TEST_DB_DIR).toBe(path.join(process.env.HOME!, 'test-dbs'));
  });

  it('os.homedir() honors the pinned HOME — or the run was launched via the spawn-time Stryker guard', () => {
    // Probe the libuv linkage directly: re-point the JS-level HOME and check
    // whether os.homedir() follows.
    const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-probe-'));
    // libuv reads USERPROFILE on Windows (the pin sets both), HOME elsewhere.
    const key = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
    const prev = process.env[key]!;
    process.env[key] = probeDir;
    let follows = false;
    try { follows = os.homedir() === probeDir; } finally { process.env[key] = prev; }
    fs.rmSync(probeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    if (follows) return; // forks pool (normal runs, CI): libuv linkage holds.
    // Frozen C environ (Stryker threads pool): HOME can only reach
    // os.homedir() if it was baked in at SPAWN time — require the guard's
    // marker so an unguarded Stryker launch fails LOUDLY instead of letting
    // tests silently write into the machine home.
    expect(
      process.env.AGENFK_SPAWN_PIN,
      'os.homedir() linkage is frozen in this runner — launch Stryker via `npm run test:stryker`',
    ).toBe('1');
  });

  it('the deadletter path resolves against the CURRENT homedir (lazy)', () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-lazy-'));
    vi.mocked(os.homedir).mockReturnValue(sandbox);
    try {
      expect(defaultDeadletterPath()).toBe(path.join(sandbox, '.agenfk', 'hub-deadletter.jsonl'));
    } finally {
      vi.mocked(os.homedir).mockRestore();
      fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('the telemetry agenfk dir resolves against the CURRENT homedir (lazy)', () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-lazy-'));
    vi.mocked(os.homedir).mockReturnValue(sandbox);
    try {
      expect(agenfkDir()).toBe(path.join(sandbox, '.agenfk'));
    } finally {
      vi.mocked(os.homedir).mockRestore();
      fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('a write through the lazy hub path lands in the sandbox homedir, never the real home', () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-lazy-'));
    vi.mocked(os.homedir).mockReturnValue(sandbox);
    try {
      const p = hubConfigPath();
      expect(p.startsWith(sandbox)).toBe(true);
      // The real home's framework dir, not the real home as a whole: on Windows
      // the temp dir - and so the sandbox - sits inside the user profile (#208).
      expect(p.startsWith(path.join(REAL_HOME!, '.agenfk')), 'path must not point into the real home').toBe(false);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify({ url: 'https://sandbox.example', token: 'test-token', orgId: 'test-org' }));
      expect(JSON.parse(fs.readFileSync(p, 'utf8')).token).toBe('test-token');
      fs.rmSync(p, { force: true });
    } finally {
      vi.mocked(os.homedir).mockRestore();
      fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

/**
 * The environment the suite is LAUNCHED from (BUG 6b3e7a98).
 *
 * A sibling of the HOME pinning above, and it comes from the same lesson one
 * level out. `server.ts` mounts the static UI at module level when
 * `AGENFK_SERVE_UI` is set — so a suite that inherits it is testing a different
 * Express app than the one these tests were written against: `GET /` answers a
 * page instead of the API's JSON.
 *
 * It is inherited exactly when the suite is run BY the framework. `agenfk
 * verify` spawns the command from the server, and the server was launched by
 * the desktop app, which sets this to the bundle inside the .app. So the suite
 * passed from a shell and failed from the tool, and which assertions broke
 * depended on which files were in that run — which reads as "a different test
 * every time".
 *
 * Worth a test rather than trusting the config, because the failure it
 * prevents does not look like a configuration problem. It looks like flakiness,
 * and it cost eleven hypotheses that all went looking for state shared BETWEEN
 * tests. There is none. The shared state was the environment.
 */
describe('the launching environment', () => {
  it('does not let AGENFK_SERVE_UI through', () => {
    expect(process.env.AGENFK_SERVE_UI || '').toBe('');
  });

  it('spells the temp dir and the sandbox HOME in full, as git and realpath report them (#208)', () => {
    // Windows hands out TEMP in 8.3 form (C:\Users\FABIOT~1\..., RUNNER~1 on
    // CI) while git lists and realpath.native returns the long name: specs then
    // compare two spellings of one directory.
    //
    // macOS cannot satisfy this for the temp dir: its temp root (/var) IS a
    // symlink to /private/var, so os.tmpdir() is spelled THROUGH it by
    // construction and never equals its own realpath. The #208 hazard is a
    // temp path that disagrees with what git/realpath return, and on darwin
    // both sides agree on /private/var — there is nothing to compare. Keep the
    // assertion where a symlinked temp root is not the OS's design (Linux and
    // Windows).
    if (process.platform !== 'darwin') {
      expect(os.tmpdir()).toBe(fs.realpathSync.native(os.tmpdir()));
    }
    expect(process.env.HOME).toBe(fs.realpathSync.native(process.env.HOME!));
  });
});
