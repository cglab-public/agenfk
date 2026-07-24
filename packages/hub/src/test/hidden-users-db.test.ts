// Tests for the hidden_users table (CGLAB-31): schema bootstrap on both
// backends (SQLite + pg-mem), basic hide/unhide/list semantics at the SQL
// level, and org-rename registration so hidden rows follow an org rename.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { HubDb } from '../db/types';
import { openSqliteDb } from '../db/sqlite';
import { openPgMemDb } from '../db/postgres';

const TEST_DB = path.join(os.tmpdir(), `agenfk-hidden-users-db-${process.pid}.sqlite`);
const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};

function backendSuite(name: string, open: () => Promise<HubDb>, introspect: (db: HubDb) => Promise<string[]>) {
  describe(`hidden_users table (${name})`, () => {
    let db: HubDb;

    beforeEach(async () => {
      cleanup();
      db = await open();
    });

    afterEach(async () => {
      try { await db.close(); } catch { /* already closed */ }
      cleanup();
    });

    it('bootstrap creates the hidden_users table', async () => {
      const names = await introspect(db);
      expect(names).toContain('hidden_users');
    });

    it('stores a hidden person keyed on (org_id, user_key)', async () => {
      await db.run(
        `INSERT INTO hidden_users (org_id, user_key, hidden_by_user_id, hidden_by_email)
         VALUES (?, ?, ?, ?)`,
        ['org', 'departed@acme.com', 'u-admin', 'admin@acme.com'],
      );
      const row = await db.get<{ org_id: string; user_key: string; hidden_by_email: string; created_at: unknown }>(
        'SELECT org_id, user_key, hidden_by_email, created_at FROM hidden_users WHERE org_id = ? AND user_key = ?',
        ['org', 'departed@acme.com'],
      );
      expect(row?.org_id).toBe('org');
      expect(row?.user_key).toBe('departed@acme.com');
      expect(row?.hidden_by_email).toBe('admin@acme.com');
      expect(row?.created_at).toBeTruthy();
    });

    it('enforces the (org_id, user_key) primary key — same person can be hidden in two orgs but not twice in one', async () => {
      await db.run(
        `INSERT INTO hidden_users (org_id, user_key) VALUES (?, ?)`,
        ['org', 'departed@acme.com'],
      );
      // Same user_key in a different org is fine.
      await db.run(
        `INSERT INTO hidden_users (org_id, user_key) VALUES (?, ?)`,
        ['other-org', 'departed@acme.com'],
      );
      // Duplicate in the same org must throw.
      await expect(
        db.run(`INSERT INTO hidden_users (org_id, user_key) VALUES (?, ?)`, ['org', 'departed@acme.com']),
      ).rejects.toThrow();
    });

    it('delete reverses the hide (unhide)', async () => {
      await db.run(`INSERT INTO hidden_users (org_id, user_key) VALUES (?, ?)`, ['org', 'departed@acme.com']);
      const r = await db.run('DELETE FROM hidden_users WHERE org_id = ? AND user_key = ?', ['org', 'departed@acme.com']);
      expect(r.changes).toBe(1);
      expect(await db.get('SELECT user_key FROM hidden_users WHERE org_id = ?', ['org'])).toBeUndefined();
    });

    it('list query returns all hidden people for an org', async () => {
      await db.run(`INSERT INTO hidden_users (org_id, user_key) VALUES (?, ?)`, ['org', 'a@acme.com']);
      await db.run(`INSERT INTO hidden_users (org_id, user_key) VALUES (?, ?)`, ['org', 'b@acme.com']);
      await db.run(`INSERT INTO hidden_users (org_id, user_key) VALUES (?, ?)`, ['other', 'c@acme.com']);
      const rows = await db.all<{ user_key: string }>(
        'SELECT user_key FROM hidden_users WHERE org_id = ? ORDER BY user_key',
        ['org'],
      );
      expect(rows.map(r => r.user_key)).toEqual(['a@acme.com', 'b@acme.com']);
    });
  });
}

backendSuite(
  'sqlite',
  () => openSqliteDb(TEST_DB),
  async (db) => {
    const rows = await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'");
    return rows.map(r => r.name);
  },
);

backendSuite(
  'postgres',
  () => openPgMemDb(),
  async (db) => {
    const rows = await db.all<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    );
    return rows.map(r => r.table_name);
  },
);

describe('hidden_users org-rename registration', () => {
  it('ORG_ID_CHILD_TABLES includes hidden_users so rows follow an org rename', async () => {
    const mod = await import('../routes/orgRename');
    const tables = (mod as any).ORG_ID_CHILD_TABLES as string[];
    expect(tables).toContain('hidden_users');
  });
});
