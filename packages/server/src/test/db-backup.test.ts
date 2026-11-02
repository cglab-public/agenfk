/**
 * GH-288 — backups are SQLite snapshots of the whole database, five are kept,
 * a failed one is reported by `agenfk db status` instead of only logged, and
 * a snapshot the installer stages restores on a new install.
 */
import { removeTestDb, testDbPath } from './helpers/testDb';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('axios', () => { const m = vi.fn() as any; m.get = vi.fn(); m.post = vi.fn(); m.create = vi.fn(() => m); return { default: m }; });

const TEST_DB = testDbPath('db-backup-test-db.sqlite');
process.env.AGENFK_DB_PATH = TEST_DB;
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

import { app, initStorage, closeStorage, storage, VERIFY_TOKEN } from '../server';
import { SQLiteStorageProvider } from '@agenfk/storage-sqlite';

const backupDir = path.join(os.homedir(), '.agenfk', 'backup');
const migration = path.join(os.homedir(), '.agenfk', 'migration.sqlite');

let __server: import('http').Server;
const agent = () => request(__server);
beforeAll(async () => { await initStorage(); __server = app.listen(0); });
afterAll(async () => {
  await new Promise<void>(r => __server.close(() => r()));
  await removeTestDb(TEST_DB, closeStorage);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(backupDir, { recursive: true, force: true });
  fs.rmSync(migration, { force: true });
});

const backup = () => agent().post('/backup').set('x-agenfk-internal', VERIFY_TOKEN);
// Read through the provider, on a copy so the backup itself is left as written.
async function projectsIn(file: string): Promise<string[]> {
  const copy = `${file}.read`;
  fs.copyFileSync(file, copy);
  const p = new SQLiteStorageProvider();
  try {
    await p.init({ path: copy });
    return (await p.listProjects()).map(x => x.name);
  } finally {
    await p.shutdown();
    for (const s of ['', '-wal', '-shm']) fs.rmSync(copy + s, { force: true });
  }
}

describe('POST /backup', () => {
  it('writes a SQLite snapshot of the whole database', async () => {
    await agent().post('/projects').send({ name: 'in-the-backup' });
    const res = await backup();
    expect(res.status).toBe(200);
    expect(res.body.backupPath).toMatch(/agenfk-backup-.*\.sqlite$/);
    expect(await projectsIn(res.body.backupPath)).toContain('in-the-backup');
  });

  it('keeps the five newest backups, old JSON ones included', async () => {
    fs.mkdirSync(backupDir, { recursive: true });
    const old = ['2026-01-01', '2026-01-02', '2026-01-03'].map(d => `agenfk-backup-${d}T00-00-00.000Z.json`)
      .concat(['2026-01-04', '2026-01-05', '2026-01-06'].map(d => `agenfk-backup-${d}T00-00-00.000Z.sqlite`));
    for (const f of old) fs.writeFileSync(path.join(backupDir, f), 'x');
    const made = path.basename((await backup()).body.backupPath);
    expect(fs.readdirSync(backupDir).filter(f => f.startsWith('agenfk-backup-')).sort())
      .toEqual([...old.slice(2), made].sort());
  });
});

// Review of GH-288 (Codex).
describe('POST /backup, the edges', () => {
  it('keeps the backup it just wrote even when the others sort after it (a clock set back)', async () => {
    fs.mkdirSync(backupDir, { recursive: true });
    const later = ['01', '02', '03', '04', '05'].map(d => `agenfk-backup-2099-01-${d}T00-00-00.000Z.sqlite`);
    for (const f of later) fs.writeFileSync(path.join(backupDir, f), 'x');
    const made = path.basename((await backup()).body.backupPath);
    expect(fs.readdirSync(backupDir).sort()).toEqual([...later.slice(1), made].sort());
  });

  it('runs one backup at a time: a second asked for meanwhile shares the first', async () => {
    // The first snapshot is held open until the second request has arrived, so they overlap.
    const real = SQLiteStorageProvider.prototype.snapshotTo;
    let letGo!: () => void;
    const held = new Promise<void>(r => { letGo = r; });
    let started!: () => void;
    const inSnapshot = new Promise<void>(r => { started = r; });
    const spy = vi.spyOn(SQLiteStorageProvider.prototype, 'snapshotTo').mockImplementation(async function (this: SQLiteStorageProvider, ...args) {
      started();
      await held;
      return real.apply(this, args);
    });
    const first = backup().then(r => r);
    await inSnapshot;
    const second = backup().then(r => r);
    await new Promise(r => setTimeout(r, 50));
    letGo();
    const [a, b] = await Promise.all([first, second]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(a.status).toBe(200);
    expect(b.body.backupPath).toBe(a.body.backupPath);
    expect(fs.readdirSync(backupDir)).toEqual([path.basename(a.body.backupPath)]);
  });
});

describe('GET /db/status, backups', () => {
  it('counts both kinds and names the newest', async () => {
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, 'agenfk-backup-2026-01-01T00-00-00.000Z.json'), 'x');
    fs.writeFileSync(path.join(backupDir, 'agenfk-backup-2026-01-02T00-00-00.000Z.sqlite'), 'x');
    const made = path.basename((await backup()).body.backupPath);
    const res = await agent().get('/db/status');
    expect(res.body.backupCount).toBe(3);
    expect(res.body.latestBackup).toBe(made);
  });

  it('reports a backup that failed until the next one succeeds', async () => {
    vi.spyOn(SQLiteStorageProvider.prototype, 'snapshotTo').mockRejectedValueOnce(new Error('disk full'));
    expect((await backup()).status).toBe(500);
    const failed = (await agent().get('/db/status')).body.lastBackupError;
    expect(failed.error).toMatch(/disk full/);
    expect(Number.isNaN(Date.parse(failed.at))).toBe(false);
    expect((await backup()).status).toBe(200);
    expect((await agent().get('/db/status')).body.lastBackupError).toBeNull();
  });
});

describe('restoring a staged snapshot', () => {
  async function stageSnapshotOf(name: string) {
    const src = path.join(path.dirname(TEST_DB), `restore-src-${Date.now()}.sqlite`);
    const p = new SQLiteStorageProvider();
    await p.init({ path: src });
    await p.createProject({ id: `rp-${Date.now()}`, name, description: '', createdAt: new Date(), updatedAt: new Date() } as any);
    fs.mkdirSync(path.dirname(migration), { recursive: true });
    await p.snapshotTo(migration);
    await p.shutdown();
    fs.rmSync(src, { force: true });
  }

  afterEach(async () => {
    process.env.AGENFK_DB_PATH = TEST_DB;
    await initStorage();
  });

  it('becomes the database of a new install, and is consumed', async () => {
    await stageSnapshotOf('restored-project');
    const fresh = testDbPath(`db-backup-fresh-${Date.now()}.sqlite`);
    process.env.AGENFK_DB_PATH = fresh;
    await initStorage();
    expect((await storage.listProjects()).map(p => p.name)).toContain('restored-project');
    expect(fs.existsSync(migration)).toBe(false);
  });

  // Review of GH-288 (Codex): a staged copy that is not a whole database stops
  // the start - an empty database in its place would block any later restore.
  for (const [what, spoil] of [
    ['cut short', (f: string) => fs.truncateSync(f, Math.floor(fs.statSync(f).size / 2))],
    ['empty', (f: string) => fs.truncateSync(f, 0)],
  ] as const) {
    it(`refuses to start on a staged snapshot that is ${what}, creating no database and keeping it staged`, async () => {
      await stageSnapshotOf(`spoiled-${what}`);
      spoil(migration);
      const fresh = testDbPath(`db-backup-spoiled-${Date.now()}.sqlite`);
      process.env.AGENFK_DB_PATH = fresh;
      await expect(initStorage()).rejects.toThrow(/not a whole database.*Replace it|remove it/);
      expect(fs.existsSync(fresh)).toBe(false);
      expect(fs.existsSync(`${fresh}.restoring`)).toBe(false);
      expect(fs.existsSync(migration)).toBe(true);
    });
  }

  it('refuses a staged SQLite file that is not an AgEnFK database', async () => {
    fs.mkdirSync(path.dirname(migration), { recursive: true });
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    const other = new DatabaseSync(migration);
    other.exec('CREATE TABLE notes (body TEXT)');
    other.close();
    process.env.AGENFK_DB_PATH = testDbPath(`db-backup-other-${Date.now()}.sqlite`);
    await expect(initStorage()).rejects.toThrow(/not an AgEnFK database/);
  });

  it('never replaces a database that already exists, and stays staged', async () => {
    await stageSnapshotOf('must-not-land');
    process.env.AGENFK_DB_PATH = TEST_DB;
    await initStorage();
    expect((await storage.listProjects()).map(p => p.name)).not.toContain('must-not-land');
    expect(fs.existsSync(migration)).toBe(true);
  });
});
