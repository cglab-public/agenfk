/**
 * Phase 1a (INFRA-463): createSsoMember against both backends. The sign-in
 * routes run one callback at a time on SQLite, so the insert-conflict path is
 * pinned here directly: the second insert for an identity is exactly what a
 * race between two first sign-ins produces.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { HubDb } from '../db/types';
import { openSqliteDb } from '../db/sqlite';
import { openPgMemDb, __migrateForTest } from '../db/postgres';
import { createSsoMember, findInvitedSsoUser } from '../auth/oauth';

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

    // Another identity already holds the email, and the insert then fails with
    // the given error: the state a lost race leaves, minus a real unique error.
    // The other row goes in first because the member insert runs in a
    // transaction that a failure rolls back.
    const failingAfterEmailTaken = async (err: Error) => {
      await db.run("INSERT INTO users (id, org_id, email, provider, provider_subject, role) VALUES ('u-other', 'org', ?, 'entra', 'oid-other', 'viewer')", [person.email]);
      return new Proxy(db, {
        get(target, prop, receiver) {
          if (prop === 'run') {
            return (sql: string, params?: any) => (/^\s*INSERT INTO users/i.test(sql) ? Promise.reject(err) : target.run(sql, params));
          }
          const v = Reflect.get(target, prop, receiver);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
    };

    it('rethrows a non-unique insert failure even when a row with the same email exists', async () => {
      const err = Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' });
      await expect(createSsoMember((await failingAfterEmailTaken(err)) as HubDb, 'org', person)).rejects.toThrow('disk I/O error');
    });

    it('rethrows a failure that carries no error code even when a row with the same email exists', async () => {
      await expect(createSsoMember((await failingAfterEmailTaken(new Error('connection terminated'))) as HubDb, 'org', person)).rejects.toThrow('connection terminated');
    });

    // node:sqlite reports every failure as ERR_SQLITE_ERROR with the extended result code in errcode.
    it.each([
      ['node:sqlite unique (2067)', { code: 'ERR_SQLITE_ERROR', errcode: 2067 }],
      ['postgres unique (23505)', { code: '23505' }],
    ])('reads a unique violation, %s, on a taken email as bound-elsewhere', async (_label, fields) => {
      const err = Object.assign(new Error('unique violation'), fields);
      expect(await createSsoMember((await failingAfterEmailTaken(err)) as HubDb, 'org', person)).toEqual({ refused: 'bound-elsewhere' });
    });

    it('rethrows a node:sqlite NOT NULL failure (1299) even when the email is taken', async () => {
      const err = Object.assign(new Error('NOT NULL constraint failed'), { code: 'ERR_SQLITE_ERROR', errcode: 1299 });
      await expect(createSsoMember((await failingAfterEmailTaken(err)) as HubDb, 'org', person)).rejects.toThrow('NOT NULL');
    });

    it('refuses, and leaves unbound and unaudited, an invited row whose bind loses the subject to another row', async () => {
      await createSsoMember(db, 'org', person);
      await db.run("INSERT INTO users (id, org_id, email, provider, role) VALUES ('u-inv', 'org', 'invited@acme.com', 'password', 'viewer')");
      // A sign-in that looks the subject up before the other one commits: its
      // first by-subject read finds nothing, then the bind meets the index.
      let reads = 0;
      const racing = new Proxy(db, {
        get(target, prop, receiver) {
          if (prop === 'get') {
            return (sql: string, params?: any) => (/provider_subject = \?/.test(sql) && reads++ === 0 ? Promise.resolve(undefined) : target.get(sql, params));
          }
          const v = Reflect.get(target, prop, receiver);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
      const r = await findInvitedSsoUser(racing as HubDb, 'org', { ...person, email: 'invited@acme.com' });
      expect(r).toEqual({ refused: 'bound-elsewhere' });
      expect(await db.get<any>("SELECT provider, provider_subject FROM users WHERE id = 'u-inv'")).toEqual({ provider: 'password', provider_subject: null });
      expect(await db.all<any>("SELECT id FROM config_audit WHERE action = 'user.sso_bind'")).toHaveLength(0);
    });

    it('rethrows a non-unique failure of the bind, leaving the invited row unbound and unaudited', async () => {
      await db.run("INSERT INTO users (id, org_id, email, provider, role) VALUES ('u-inv', 'org', 'invited@acme.com', 'password', 'viewer')");
      const err = Object.assign(new Error('NOT NULL constraint failed'), { code: 'ERR_SQLITE_ERROR', errcode: 1299 });
      const failing = new Proxy(db, {
        get(target, prop, receiver) {
          if (prop === 'run') {
            return (sql: string, params?: any) => (/^\s*UPDATE users SET provider/i.test(sql) ? Promise.reject(err) : target.run(sql, params));
          }
          const v = Reflect.get(target, prop, receiver);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
      await expect(findInvitedSsoUser(failing as HubDb, 'org', { ...person, email: 'invited@acme.com' })).rejects.toBe(err);
      expect(await db.get<any>("SELECT provider, provider_subject FROM users WHERE id = 'u-inv'")).toEqual({ provider: 'password', provider_subject: null });
      expect(await db.all<any>("SELECT id FROM config_audit WHERE action = 'user.sso_bind'")).toHaveLength(0);
    });

    it('leaves no member behind when the audit entry cannot be written, so the next sign-in creates both', async () => {
      await db.exec('ALTER TABLE config_audit RENAME TO config_audit_away');
      await expect(createSsoMember(db, 'org', person)).rejects.toThrow();
      // pg-mem raises the error and issues ROLLBACK but does not undo writes
      // (see hubdb-postgres.test.ts), so the row check holds only where a
      // rollback is real.
      if (name === 'sqlite') expect(await db.all<any>('SELECT id FROM users')).toHaveLength(0);
      else await db.run('DELETE FROM users');
      await db.exec('ALTER TABLE config_audit_away RENAME TO config_audit');
      const again = await createSsoMember(db, 'org', person);
      expect('user' in again).toBe(true);
      expect(await db.all<any>('SELECT id FROM users')).toHaveLength(1);
      expect(await db.all<any>("SELECT id FROM config_audit WHERE action = 'user.jit_create'")).toHaveLength(1);
    });

    describe('provider subject uniqueness', () => {
      const ins = (id: string, email: string, provider: string, subject: string | null) =>
        db.run('INSERT INTO users (id, org_id, email, provider, provider_subject, role) VALUES (?, ?, ?, ?, ?, ?)', [id, 'org', email, provider, subject, 'viewer']);

      it('refuses two rows with the same provider and subject', async () => {
        await ins('u1', 'a@acme.com', 'entra', 'oid-1');
        await expect(ins('u2', 'b@acme.com', 'entra', 'oid-1')).rejects.toThrow();
        expect(await db.all<any>('SELECT id FROM users')).toHaveLength(1);
      });

      it('allows the same subject under another provider', async () => {
        await ins('u1', 'a@acme.com', 'entra', 'oid-1');
        await ins('u2', 'b@acme.com', 'google', 'oid-1');
        expect(await db.all<any>('SELECT id FROM users')).toHaveLength(2);
      });

      it('does not constrain password rows', async () => {
        await ins('u1', 'a@acme.com', 'password', 'same');
        await ins('u2', 'b@acme.com', 'password', 'same');
        expect(await db.all<any>('SELECT id FROM users')).toHaveLength(2);
      });

      it('does not constrain rows without a subject', async () => {
        await ins('u1', 'a@acme.com', 'entra', null);
        await ins('u2', 'b@acme.com', 'entra', null);
        expect(await db.all<any>('SELECT id FROM users')).toHaveLength(2);
      });
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

describe('provider subject index on an existing hub', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });
  const dupes = [['u1', 'a@acme.com'], ['u2', 'b@acme.com']];

  it('still opens a SQLite database that already holds a duplicate subject, with a warning', async () => {
    cleanup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = await openSqliteDb(TEST_DB);
    await db.run('DROP INDEX idx_users_provider_subject');
    for (const [id, email] of dupes) {
      await db.run("INSERT INTO users (id, org_id, email, provider, provider_subject, role) VALUES (?, 'org', ?, 'entra', 'oid-1', 'viewer')", [id, email]);
    }
    await db.close();
    const reopened = await openSqliteDb(TEST_DB);
    expect(await reopened.all<any>('SELECT id FROM users')).toHaveLength(2);
    expect(warn.mock.calls.some(c => /provider|subject/i.test(String(c[0])))).toBe(true);
    await reopened.close();
  });

  it('still migrates a Postgres database that already holds a duplicate subject, with a warning', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = await openPgMemDb();
    await db.run('DROP INDEX idx_users_provider_subject');
    for (const [id, email] of dupes) {
      await db.run("INSERT INTO users (id, org_id, email, provider, provider_subject, role) VALUES (?, 'org', ?, 'entra', 'oid-1', 'viewer')", [id, email]);
    }
    await __migrateForTest(db);
    expect(await db.all<any>('SELECT id FROM users')).toHaveLength(2);
    // No warning assertion here: pg-mem registers the index name even when the
    // build fails on the duplicates, so the second try finds it and succeeds
    // quietly. Real Postgres leaves nothing behind and warns, as on SQLite.
    await db.close();
  });
});
