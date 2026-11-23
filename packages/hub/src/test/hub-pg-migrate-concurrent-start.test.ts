/**
 * INFRA-463: a deploy boots two hub tasks at the same moment, and each runs
 * the migrations on the same Postgres database. A start that looked for a
 * column before the other start added it must not fail on the ALTER.
 */
import { describe, it, expect, vi } from 'vitest';
import type { HubDb } from '../db/types';
import { openPgMemDb, __migrateForTest } from '../db/postgres';

const ADDED: Record<string, string[]> = {
  auth_config: ['google_hosted_domains', 'join_mode', 'entra_required_role'],
  users: ['join_source'],
};

async function columnsOf(db: HubDb, table: string): Promise<string[]> {
  const rows = await db.all<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1", [table],
  );
  return rows.map(r => r.column_name);
}

/** The database as the build before INFRA-463 left it. */
async function openHubMadeBeforeTheColumns(): Promise<HubDb> {
  const db = await openPgMemDb();
  for (const [table, cols] of Object.entries(ADDED)) {
    for (const col of cols) await db.run(`ALTER TABLE ${table} DROP COLUMN ${col}`);
  }
  return db;
}

/**
 * A start whose column probe answered before the other start's ALTER landed:
 * the probe reports the INFRA-463 columns as missing although they exist.
 */
function withStaleColumnProbe(db: HubDb): HubDb {
  const hidden = new Set(Object.values(ADDED).flat());
  return {
    run: (sql, params) => db.run(sql, params),
    get: (sql, params) => db.get(sql, params),
    exec: sql => db.exec(sql),
    transaction: fn => db.transaction(fn),
    close: () => db.close(),
    all: async <T>(sql: string, params?: any) => {
      const rows = await db.all<T>(sql, params);
      if (!/information_schema\.columns/.test(sql) || !/'(auth_config|users)'/.test(sql)) return rows;
      return rows.filter(r => !hidden.has((r as { column_name: string }).column_name));
    },
  };
}

describe('Postgres migrations when two hub tasks start together', () => {
  it('a start that probed before the other added the columns finishes without error', async () => {
    const db = await openPgMemDb();
    await expect(__migrateForTest(withStaleColumnProbe(db))).resolves.toBeUndefined();
    await db.close();
  });

  it('two starts at once on a database made before the columns both finish, and the columns are there once', async () => {
    const db = await openHubMadeBeforeTheColumns();
    const starts = await Promise.allSettled([__migrateForTest(db), __migrateForTest(db)]);
    expect(starts.map(s => s.status)).toEqual(['fulfilled', 'fulfilled']);
    for (const [table, cols] of Object.entries(ADDED)) {
      const have = await columnsOf(db, table);
      for (const col of cols) expect(have.filter(c => c === col)).toEqual([col]);
    }
    await db.close();
  });
});

/**
 * CREATE UNIQUE INDEX IF NOT EXISTS is not safe between two sessions either:
 * the start that loses fails on the catalog although the index is then there.
 */
describe('the case-insensitive email index when two hub tasks start together', () => {
  const isEmailIndex = (sql: string) => /CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower/.test(sql);
  const failing = (db: HubDb, times: number): HubDb => {
    let left = times;
    return {
      run: (sql, params) => db.run(sql, params),
      get: (sql, params) => db.get(sql, params),
      all: (sql, params) => db.all(sql, params),
      transaction: fn => db.transaction(fn),
      close: () => db.close(),
      exec: async sql => {
        if (isEmailIndex(sql) && left-- > 0) throw new Error('duplicate key value violates unique constraint "pg_class_relname_nsp_index"');
        await db.exec(sql);
      },
    };
  };

  it('says nothing about duplicate emails when the build only lost the race', async () => {
    const db = await openPgMemDb();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await __migrateForTest(failing(db, 1));
      expect(warn.mock.calls.filter(c => /differ only in case/.test(String(c[0])))).toEqual([]);
    } finally {
      warn.mockRestore();
      await db.close();
    }
  });

  it('still warns once, and starts, when the index cannot be built at all', async () => {
    const db = await openPgMemDb();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(__migrateForTest(failing(db, Infinity))).resolves.toBeUndefined();
      expect(warn.mock.calls.filter(c => /differ only in case/.test(String(c[0])))).toHaveLength(1);
    } finally {
      warn.mockRestore();
      await db.close();
    }
  });
});
