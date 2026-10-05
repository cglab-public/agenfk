/**
 * Where the server suite keeps its sqlite databases (card c89e677d).
 *
 * 116 test files resolved their database against the cwd - the repository
 * root - and their teardown unlinked only the main file while the server's
 * WAL connection was still open. The -wal and -shm sidecars stayed behind:
 * ~60 files and ~60 MB at the root after one run, more after every run, and
 * all of it after an interrupted one.
 *
 * Every test database now lives in a per-run directory inside the HOME
 * sandbox (scripts/vitest-home-pin.mjs), so sidecars, crashed runs and the
 * server's own files next to the database never reach the repository.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { testDbPath } from './helpers/testDb';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const TEST_DIR = __dirname;

const inside = (child: string, parent: string) => {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

describe('the test database directory', () => {
  it('is pinned by the runner, absolute, and outside the repository', () => {
    const dir = process.env.AGENFK_TEST_DB_DIR;
    expect(dir, 'AGENFK_TEST_DB_DIR must be set by testEnv()').toBeTruthy();
    expect(path.isAbsolute(dir!)).toBe(true);
    expect(inside(dir!, REPO_ROOT), `${dir} is inside the repository`).toBe(false);
    expect(inside(dir!, fs.realpathSync(os.tmpdir())) || inside(dir!, os.tmpdir())).toBe(true);
  });
});

describe('testDbPath', () => {
  it('puts the database in the pinned directory, which exists', () => {
    const p = testDbPath('some-test-db.sqlite');
    expect(p).toBe(path.join(process.env.AGENFK_TEST_DB_DIR!, 'some-test-db.sqlite'));
    expect(fs.statSync(path.dirname(p)).isDirectory()).toBe(true);
    expect(inside(p, REPO_ROOT)).toBe(false);
  });

  it('refuses a name that would leave the directory', () => {
    expect(() => testDbPath('../escape.sqlite')).toThrow(/file name/);
    expect(() => testDbPath('nested/db.sqlite')).toThrow(/file name/);
    expect(() => testDbPath('')).toThrow(/file name/);
  });
});

describe('the per-run sandbox is removed when the run ends', () => {
  // Moving the databases out of the repo moved their sidecars into a sandbox
  // nothing deleted: ~50 MB more in $TMPDIR on every run (review of c89e677d).
  const load = async () => (await import('../../../../scripts/vitest-sandbox-teardown.mjs')).default as
    (project: { config: { env?: Record<string, string | undefined> } }) => () => void;

  const sandbox = () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-test-home-'));
    fs.mkdirSync(path.join(home, 'test-dbs'));
    fs.writeFileSync(path.join(home, 'test-dbs', 'x-test-db.sqlite-wal'), 'wal');
    return home;
  };

  it('deletes the sandbox the run was given, sidecars and all', async () => {
    const home = sandbox();
    (await load())({ config: { env: { HOME: home } } })();
    expect(fs.existsSync(home)).toBe(false);
  });

  it('is idempotent: every project tears down, and the second finds nothing', async () => {
    const home = sandbox();
    const setup = await load();
    setup({ config: { env: { HOME: home } } })();
    expect(() => setup({ config: { env: { HOME: home } } })()).not.toThrow();
  });

  it('never deletes a directory that is not a test sandbox under the tmpdir', async () => {
    // Decoys only: were the guard to regress, this test must not become the
    // recursive delete it guards against - no real home, no repository, and
    // not os.homedir(), which inside the run IS the live sandbox.
    const setup = await load();
    const notOurs = fs.mkdtempSync(path.join(os.tmpdir(), 'someone-else-'));
    const prefixedElsewhere = path.join(notOurs, 'agenfk-test-home-decoy');
    fs.mkdirSync(prefixedElsewhere);
    const nested = path.join(sandbox(), 'agenfk-test-home-inner');
    fs.mkdirSync(nested);
    try {
      for (const HOME of [notOurs, prefixedElsewhere, nested, '', undefined]) {
        setup({ config: { env: { HOME } } })();
      }
      expect(fs.existsSync(notOurs)).toBe(true);
      expect(fs.existsSync(prefixedElsewhere)).toBe(true);
      expect(fs.existsSync(nested)).toBe(true);
    } finally {
      fs.rmSync(notOurs, { recursive: true, force: true });
      fs.rmSync(path.dirname(nested), { recursive: true, force: true });
    }
  });

  it('is wired into every runner that pins the sandbox', async () => {
    const { sharedTest } = await import('../../../../scripts/vitest-shared-config.mjs');
    const config = sharedTest({ include: [] });
    // Building the config here mints a sandbox of its own, never this run's.
    expect(config.env.HOME).not.toBe(process.env.HOME);
    fs.rmSync(config.env.HOME, { recursive: true, force: true });
    // Absolute, or a package that runs this config from its own directory
    // (packages/hub-ui) fails to load it before running a single test.
    expect(config.globalSetup).toContain(path.join(REPO_ROOT, 'scripts/vitest-sandbox-teardown.mjs'));
  });
});

describe('no server test resolves a database against the cwd', () => {
  // A bare or ./-relative database handed to path.resolve lands in the cwd,
  // which is the repository root under `npm test` and `agenfk verify`. The
  // legacy JSON store counts: the migration writes its .sqlite beside it.
  const CWD_RELATIVE_DB = new RegExp(String.raw`path\.resolve\(\s*['"\x60](\.\/)?[^'"\x60/]*(\.sqlite|-db\.json)['"\x60]\s*\)`);

  const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return files(full);
    return /\.(test|spec)\.tsx?$|\.ts$/.test(e.name) ? [full] : [];
  });

  it('finds none', () => {
    const offenders = files(TEST_DIR)
      .flatMap(f => fs.readFileSync(f, 'utf8').split('\n')
        .map((line, i) => (CWD_RELATIVE_DB.test(line) ? `${path.relative(REPO_ROOT, f)}:${i + 1}` : null))
        .filter((x): x is string => x !== null));
    expect(offenders, `use testDbPath() from ./helpers/testDb instead:\n${offenders.join('\n')}`).toEqual([]);
  });
});
