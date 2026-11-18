/**
 * Phase 1a (INFRA-463): createSsoMember against both backends. The sign-in
 * routes run one callback at a time on SQLite, so the insert-conflict path is
 * pinned here directly: the second insert for an identity is exactly what a
 * race between two first sign-ins produces.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { HubDb } from '../db/types';
import { openSqliteDb } from '../db/sqlite';
import { openPgMemDb, __migrateForTest } from '../db/postgres';
import { createSsoMember } from '../auth/oauth';

const TEST_DB = path.join(os.tmpdir(), `agenfk-jit-create-member-${process.pid}.sqlite`);
const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
};
const person = { provider: 'entra' as const, subject: 'oid-1', email: 'new@acme.com', name: 'New Person' };

function backendSuite(name: string, open: () => Promise<HubDb>) {
  describe(`createSsoMember (${name})`, () => {
    let db: HubDb;

    beforeEach(async () => {
      cleanup();
      db = await open();
    });

    afterEach(async () => {
      try { await db.close(); } catch { /* already closed */ }
      cleanup();
    });

    it('gives the second insert for the same identity the row the first one made', async () => {
      const first = await createSsoMember(db, 'org', person);
      const second = await createSsoMember(db, 'org', person);
      expect('user' in first && 'user' in second).toBe(true);
      expect((second as any).user.id).toBe((first as any).user.id);
      expect(await db.all<any>('SELECT id FROM users')).toHaveLength(1);
      expect(await db.all<any>("SELECT id FROM config_audit WHERE action = 'user.jit_create'")).toHaveLength(1);
    });

    it('records on the row that a first sign-in created it, which an invited row never carries', async () => {
      await createSsoMember(db, 'org', person);
      await db.run("INSERT INTO users (id, org_id, email, provider, role) VALUES ('u-inv', 'org', 'invited@acme.com', 'password', 'viewer')");
      expect(await db.all<any>('SELECT email, join_source FROM users ORDER BY email')).toEqual([
        { email: 'invited@acme.com', join_source: null },
        { email: 'new@acme.com', join_source: 'jit' },
      ]);
    });

    it('refuses another identity that races for the same email', async () => {
      await createSsoMember(db, 'org', person);
      expect(await createSsoMember(db, 'org', { ...person, subject: 'oid-2' })).toEqual({ refused: 'bound-elsewhere' });
    });

    it('treats an email that differs only in case as the same address', async () => {
      await createSsoMember(db, 'org', person);
      expect(await createSsoMember(db, 'org', { ...person, subject: 'oid-2', email: 'New@Acme.com' })).toEqual({ refused: 'bound-elsewhere' });
      expect(await db.all<any>('SELECT id FROM users')).toHaveLength(1);
    });

    it('surfaces an insert failure that is not a conflict instead of refusing the person', async () => {
      const failing = new Proxy(db, {
        get(target, prop, receiver) {
          if (prop === 'run') {
            return (sql: string, params?: any) => (/^\s*INSERT INTO users/i.test(sql)
              ? Promise.reject(new Error('disk I/O error'))
              : target.run(sql, params));
          }
          const v = Reflect.get(target, prop, receiver);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
      await expect(createSsoMember(failing as HubDb, 'org', person)).rejects.toThrow('disk I/O error');
    });
  });
}

backendSuite('sqlite', async () => openSqliteDb(TEST_DB));
backendSuite('pg-mem', () => openPgMemDb());

describe('case-insensitive email index on an existing hub', () => {
  afterEach(cleanup);

  it('still opens a database that already holds emails differing only in case', async () => {
    cleanup();
    const db = await openSqliteDb(TEST_DB);
    await db.run('DROP INDEX idx_users_email_lower');
    for (const [id, email] of [['u1', 'bob@acme.com'], ['u2', 'Bob@acme.com']]) {
      await db.run("INSERT INTO users (id, org_id, email, provider, role) VALUES (?, 'org', ?, 'password', 'viewer')", [id, email]);
    }
    await db.close();
    const reopened = await openSqliteDb(TEST_DB);
    expect(await reopened.all<any>('SELECT id FROM users')).toHaveLength(2);
    await reopened.close();
  });
});

describe('users.join_source on an existing hub', () => {
  afterEach(cleanup);

  it('is added to a database made before it, and the rows already there read as invited', async () => {
    cleanup();
    const db = await openSqliteDb(TEST_DB);
    await db.run('ALTER TABLE users DROP COLUMN join_source');
    await db.run("INSERT INTO users (id, org_id, email, provider, provider_subject, role) VALUES ('u1', 'org', 'old@acme.com', 'entra', 'oid-old', 'viewer')");
    await db.close();
    const reopened = await openSqliteDb(TEST_DB);
    expect(await reopened.all<any>('SELECT id, join_source FROM users')).toEqual([{ id: 'u1', join_source: null }]);
    await reopened.close();
  });

  it('is added on Postgres too, when the hub starts again on a database made before it', async () => {
    const db = await openPgMemDb();
    await db.run('ALTER TABLE users DROP COLUMN join_source');
    await db.run("INSERT INTO users (id, org_id, email, provider, provider_subject, role) VALUES ('u1', 'org', 'old@acme.com', 'entra', 'oid-old', 'viewer')");
    await __migrateForTest(db);
    expect(await db.all<any>('SELECT id, join_source FROM users')).toEqual([{ id: 'u1', join_source: null }]);
    await db.close();
  });
});
