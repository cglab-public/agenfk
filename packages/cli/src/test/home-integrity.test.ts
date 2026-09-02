/**
 * Home-integrity sentinel (item 9c297075) — the 2026-08-31 clobber went
 * unnoticed for days because nothing detected that ~/.agenfk/hub.json had
 * been overwritten by a test fixture.
 *
 * The sentinel snapshots the protected home files before a test run and fails
 * the run on any drift (changed / added / removed). It is exercised here
 * against a FAKE home (the real one is never touched by tests — the vitest
 * HOME pin guarantees that).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  PROTECTED_FILES,
  snapshotHome,
  verifyHome,
} from '../../../../scripts/home-integrity.mjs';

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
  it('protects exactly the credential/config files, not DB or backups', () => {
    expect(PROTECTED_FILES).toContain('hub.json');
    expect(PROTECTED_FILES).toContain('verify-token');
    expect(PROTECTED_FILES).toContain('config.json');
    expect(PROTECTED_FILES).toContain('installation-id');
    expect(PROTECTED_FILES).toContain('server-port');
    expect(PROTECTED_FILES).toContain('hub-deadletter.jsonl');
    expect(PROTECTED_FILES).toContain('hub-audit.jsonl');
    expect(PROTECTED_FILES).not.toContain('db.sqlite');
    expect(PROTECTED_FILES).not.toContain('backup');
  });

  it('reports ok when the protected files are untouched', () => {
    const home = seedHome();
    const snap = snapshotHome(home);
    const res = verifyHome(home, snap);
    expect(res.ok).toBe(true);
    expect(res.drift).toEqual([]);
  });

  it('flags a CHANGED protected file (the clobber case)', () => {
    const home = seedHome();
    const snap = snapshotHome(home);
    fs.writeFileSync(path.join(home, '.agenfk', 'hub.json'), JSON.stringify({ url: 'http://hub.test', token: 'tok123', orgId: 'acme' }));
    const res = verifyHome(home, snap);
    expect(res.ok).toBe(false);
    expect(res.drift).toEqual(['hub.json']);
  });

  it('flags a REMOVED protected file (the rm -f case)', () => {
    const home = seedHome();
    const snap = snapshotHome(home);
    fs.rmSync(path.join(home, '.agenfk', 'verify-token'));
    const res = verifyHome(home, snap);
    expect(res.ok).toBe(false);
    expect(res.drift).toContain('verify-token');
  });

  it('flags an ADDED protected file (tests writing hub-audit.jsonl into a real home)', () => {
    const home = seedHome();
    const snap = snapshotHome(home);
    fs.writeFileSync(path.join(home, '.agenfk', 'hub-audit.jsonl'), '{"at":"x"}\n');
    const res = verifyHome(home, snap);
    expect(res.ok).toBe(false);
    expect(res.drift).toContain('hub-audit.jsonl');
  });

  it('ignores unprotected files (db churn, new backups)', () => {
    const home = seedHome();
    const snap = snapshotHome(home);
    fs.writeFileSync(path.join(home, '.agenfk', 'db.sqlite'), 'CHANGED');
    fs.writeFileSync(path.join(home, '.agenfk', 'backup', 'agenfk-backup-new.json'), '{}');
    const res = verifyHome(home, snap);
    expect(res.ok).toBe(true);
    expect(res.drift).toEqual([]);
  });
});
