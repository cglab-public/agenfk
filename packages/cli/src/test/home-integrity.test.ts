/**
 * Home-integrity sentinel (item 9c297075) — the 2026-08-31 clobber went
 * unnoticed for days because nothing detected that ~/.agenfk/hub.json had
 * been overwritten by a test fixture.
 *
 * The sentinel snapshots the protected home files before a test run and fails
 * the run on any drift (changed / added / removed). It is exercised here
 * against a FAKE home (the real one is never touched by tests — the vitest
 * HOME pin guarantees that).
 *
 * Note the LAZY dynamic import below: Stryker's per-test coverage attributes
 * module-initialization code (the PROTECTED_FILES literal) to whichever test
 * first evaluates the module. A static top-level import would evaluate the
 * array before any test runs, leaving its mutants uncoverable — the names
 * would survive mutation testing untested.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Mockable homedir (delegates to the real one unless a test re-points it).
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: vi.fn(() => actual.homedir()) };
});

type IntegrityModule = typeof import('../../../../scripts/home-integrity.mjs');
let integrity: IntegrityModule | null = null;
// First call happens INSIDE a test, so the module's import-time code
// (PROTECTED_FILES) is coverage-attributed to that test.
const loadIntegrity = () => (integrity ??= import('../../../../scripts/home-integrity.mjs'));

function seedHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-home-integrity-'));
  const dir = path.join(home, '.agenfk');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'hub.json'), JSON.stringify({ url: 'https://hub.example', token: 't', orgId: 'o' }));
  fs.writeFileSync(path.join(dir, 'verify-token'), 'tok-123');
  fs.writeFileSync(path.join(dir, 'config.json'), '{}');
  // Deliberately UNprotected files — must never be flagged:
  fs.writeFileSync(path.join(dir, 'db.sqlite'), 'BINARY');
  fs.mkdirSync(path.join(dir, 'backup'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'backup', 'agenfk-backup-x.json'), '{}');
  return home;
}

describe('home integrity sentinel (item 9c297075)', () => {
  it('protects exactly the credential/config files, not DB or backups', async () => {
    const mod = await loadIntegrity();
    // Every protected name must be asserted individually: a blanked entry
    // (mutation) must break the list.
    const expected = [
      'hub.json',
      'verify-token',
      'config.json',
      'installation-id',
      'server-port',
      'hub-deadletter.jsonl',
      'hub-audit.jsonl',
      'jira-token.json',
      'migration.json',
    ];
    expect(mod.PROTECTED_FILES).toEqual(expected);
    expect(mod.PROTECTED_FILES).not.toContain('db.sqlite');
    expect(mod.PROTECTED_FILES).not.toContain('backup');
  });

  it('reports ok when the protected files are untouched', async () => {
    const mod = await loadIntegrity();
    const home = seedHome();
    const snap = mod.snapshotHome(home);
    const res = mod.verifyHome(home, snap);
    expect(res.ok).toBe(true);
    expect(res.drift).toEqual([]);
  });

  it('flags a CHANGED protected file (the clobber case)', async () => {
    const mod = await loadIntegrity();
    const home = seedHome();
    const snap = mod.snapshotHome(home);
    fs.writeFileSync(path.join(home, '.agenfk', 'hub.json'), JSON.stringify({ url: 'http://hub.test', token: 'tok123', orgId: 'acme' }));
    const res = mod.verifyHome(home, snap);
    expect(res.ok).toBe(false);
    expect(res.drift).toEqual(['hub.json']);
  });

  it('flags a same-size content change (sha drift with unchanged size)', async () => {
    const mod = await loadIntegrity();
    const home = seedHome();
    const snap = mod.snapshotHome(home);
    // Same length, different bytes: size unchanged, sha changed. Catches
    // mutation of the sha-comparison half of the change detector.
    fs.writeFileSync(path.join(home, '.agenfk', 'verify-token'), 'xxx-456');
    const res = mod.verifyHome(home, snap);
    expect(res.ok).toBe(false);
    expect(res.drift).toEqual(['verify-token']);
  });

  it('flags a REMOVED protected file (the rm -f case)', async () => {
    const mod = await loadIntegrity();
    const home = seedHome();
    const snap = mod.snapshotHome(home);
    fs.rmSync(path.join(home, '.agenfk', 'verify-token'));
    const res = mod.verifyHome(home, snap);
    expect(res.ok).toBe(false);
    expect(res.drift).toContain('verify-token');
  });

  it('flags an ADDED protected file (tests writing hub-audit.jsonl into a real home)', async () => {
    const mod = await loadIntegrity();
    const home = seedHome();
    const snap = mod.snapshotHome(home);
    fs.writeFileSync(path.join(home, '.agenfk', 'hub-audit.jsonl'), '{"at":"x"}\n');
    const res = mod.verifyHome(home, snap);
    expect(res.ok).toBe(false);
    expect(res.drift).toContain('hub-audit.jsonl');
  });

  it('ignores unprotected files (db churn, new backups)', async () => {
    const mod = await loadIntegrity();
    const home = seedHome();
    const snap = mod.snapshotHome(home);
    fs.writeFileSync(path.join(home, '.agenfk', 'db.sqlite'), 'CHANGED');
    fs.writeFileSync(path.join(home, '.agenfk', 'backup', 'agenfk-backup-new.json'), '{}');
    const res = mod.verifyHome(home, snap);
    expect(res.ok).toBe(true);
    expect(res.drift).toEqual([]);
  });
});

describe('vitest HOME pin factory (scripts/vitest-home-pin.mjs)', () => {
  it('memoizes one sandbox per process and pins HOME off the real home', async () => {
    const pin = await import('../../../../scripts/vitest-home-pin.mjs');
    const a = pin.testHomeEnv();
    const b = pin.testHomeEnv();
    expect(b, 'second call must return the SAME memoized env').toBe(a);
    expect(a.HOME).toBeTruthy();
    // Compare the REALPATH of both sides: the factory builds the sandbox under
    // the long (resolved) temp dir, while os.tmpdir() can be the platform's
    // symlinked spelling (macOS /var -> /private/var) or 8.3 form (Windows).
    // Identity is what the pin guarantees, not one spelling of it.
    expect(fs.realpathSync.native(path.dirname(a.HOME)), 'pin must land in a fresh tmpdir sandbox')
      .toBe(fs.realpathSync.native(os.tmpdir()));
    // The prefix this run uses: the accented one under AGENFK_TEST_UNICODE_HOME (#201).
    expect(a.HOME, 'sandbox name must carry the recognizable prefix')
      .toContain(pin.testHomePrefix());
    expect(a.USERPROFILE, 'Windows parity key').toBe(a.HOME);
    expect(a.AGENFK_REAL_HOME, 'real home must be preserved for assertions').toBeTruthy();
    expect(a.AGENFK_REAL_HOME).not.toBe(a.HOME);
    // Pre-seeded framework dir: readers of verify-token/server-port see
    // "absent", not a hostile foreign home.
    expect(fs.existsSync(path.join(a.HOME, '.agenfk'))).toBe(true);
    // The run's sandbox is named for the workers, which each take a home inside it (GH-274).
    expect(a.AGENFK_TEST_RUN_HOME).toBe(a.HOME);
  });
});

/*
 * GH-274: one HOME per WORKER, inside the run's sandbox. The server, hub and
 * cli files ran one at a time because every worker shared the run's HOME; a
 * home of its own lets a worker run them beside another worker's.
 */
describe('vitest worker HOME (scripts/vitest-home-pin.mjs)', () => {
  const load = () => import('../../../../scripts/vitest-home-pin.mjs');
  const runSandbox = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-test-home-'));

  it('gives each worker its own seeded home and database directory inside the run sandbox', async () => {
    const { workerHomeEnv } = await load();
    const run = runSandbox();
    try {
      const one = workerHomeEnv(run, '1');
      const two = workerHomeEnv(run, '2');
      expect(one.HOME).not.toBe(two.HOME);
      for (const w of [one, two]) {
        expect(path.dirname(w.HOME)).toBe(run);
        expect(w.USERPROFILE).toBe(w.HOME);
        expect(w.AGENFK_TEST_DB_DIR).toBe(path.join(w.HOME, 'test-dbs'));
        expect(fs.statSync(w.AGENFK_TEST_DB_DIR).isDirectory()).toBe(true);
        // The same fixed token as the run's sandbox (BUG 9de0c99c), so no worker mints an ephemeral one.
        expect(fs.readFileSync(path.join(w.HOME, '.agenfk', 'verify-token'), 'utf8')).toBe('agenfk-test-verify-token');
      }
    } finally {
      fs.rmSync(run, { recursive: true, force: true });
    }
  });

  it('is the same home for the same worker, and keeps what an earlier file left there', async () => {
    const { workerHomeEnv } = await load();
    const run = runSandbox();
    try {
      const first = workerHomeEnv(run, '3');
      fs.writeFileSync(path.join(first.HOME, 'left-by-an-earlier-file'), 'x');
      const again = workerHomeEnv(run, '3');
      expect(again).toEqual(first);
      expect(fs.existsSync(path.join(again.HOME, 'left-by-an-earlier-file'))).toBe(true);
    } finally {
      fs.rmSync(run, { recursive: true, force: true });
    }
  });

  it('pins a worker env to its own home, and leaves an env that is not a vitest worker alone', async () => {
    const { pinWorkerHome } = await load();
    const run = runSandbox();
    try {
      const env: Record<string, string | undefined> = { HOME: run, USERPROFILE: run, AGENFK_TEST_RUN_HOME: run, VITEST_POOL_ID: '4' };
      expect(pinWorkerHome(env, () => env.HOME!)).toBe(true);
      expect(env.HOME).toBe(path.join(run, 'worker-4'));
      expect(env.USERPROFILE).toBe(env.HOME);
      expect(env.AGENFK_TEST_DB_DIR).toBe(path.join(run, 'worker-4', 'test-dbs'));
      // A second file in the same worker: the same home, not one nested in it.
      expect(pinWorkerHome(env, () => env.HOME!)).toBe(true);
      expect(env.HOME).toBe(path.join(run, 'worker-4'));

      const noPool: Record<string, string | undefined> = { HOME: run, AGENFK_TEST_RUN_HOME: run };
      expect(pinWorkerHome(noPool, () => noPool.HOME!)).toBe(false);
      expect(noPool.HOME).toBe(run);
      const noRun: Record<string, string | undefined> = { HOME: run, VITEST_POOL_ID: '1' };
      expect(pinWorkerHome(noRun, () => noRun.HOME!)).toBe(false);
      expect(noRun.HOME).toBe(run);
    } finally {
      fs.rmSync(run, { recursive: true, force: true });
    }
  });

  it("keeps the run's home under the Stryker guard, where os.homedir() does not follow HOME (a frozen C environ)", async () => {
    const { pinWorkerHome } = await load();
    const run = runSandbox();
    try {
      const env: Record<string, string | undefined> = { HOME: run, USERPROFILE: run, AGENFK_TEST_RUN_HOME: run, VITEST_POOL_ID: '5', AGENFK_SPAWN_PIN: '1' };
      // HOME would say one directory and os.homedir() another: worse than sharing the run's.
      expect(pinWorkerHome(env, () => run)).toBe(false);
      expect(env.HOME).toBe(run);
      expect(env.USERPROFILE).toBe(run);
      expect(env.AGENFK_TEST_DB_DIR).toBeUndefined();
    } finally {
      fs.rmSync(run, { recursive: true, force: true });
    }
  });

  it('refuses to run a worker on the shared home anywhere else: its files would collide with the other workers', async () => {
    const { pinWorkerHome } = await load();
    const run = runSandbox();
    try {
      const env: Record<string, string | undefined> = { HOME: run, USERPROFILE: run, AGENFK_TEST_RUN_HOME: run, VITEST_POOL_ID: '6' };
      expect(() => pinWorkerHome(env, () => run)).toThrow(/cannot have a HOME of its own/);
      // Put back before it throws: nothing reads a home os.homedir() does not.
      expect(env.HOME).toBe(run);
      expect(env.AGENFK_TEST_DB_DIR).toBeUndefined();
    } finally {
      fs.rmSync(run, { recursive: true, force: true });
    }
  });
});
