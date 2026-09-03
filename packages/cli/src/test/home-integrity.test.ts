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
    expect(a.HOME, 'pin must land in a fresh tmpdir sandbox')
      .toBe(path.join(os.tmpdir(), path.basename(a.HOME)));
    expect(a.HOME, 'sandbox name must carry the recognizable prefix')
      .toContain('agenfk-test-home-');
    expect(a.USERPROFILE, 'Windows parity key').toBe(a.HOME);
    expect(a.AGENFK_REAL_HOME, 'real home must be preserved for assertions').toBeTruthy();
    expect(a.AGENFK_REAL_HOME).not.toBe(a.HOME);
    // Pre-seeded framework dir: readers of verify-token/server-port see
    // "absent", not a hostile foreign home.
    expect(fs.existsSync(path.join(a.HOME, '.agenfk'))).toBe(true);
  });
});
