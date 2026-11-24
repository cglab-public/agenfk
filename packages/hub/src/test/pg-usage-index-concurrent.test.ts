/**
 * GH-389 follow-up (BUG 0a4eb1d6): the usage overview's index on the events
 * table must be built CONCURRENTLY, in a statement of its own, and a failed
 * build must not stop the hub from booting - the BUG ab9b39d3 rule. A plain
 * CREATE INDEX holds a lock that blocks every event insert while a large
 * production table is indexed.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as pg from '../db/postgres';
const { openPgMemDb } = pg;

afterEach(() => vi.restoreAllMocks());

describe('Postgres bootstrap: the usage index', () => {
  it('is built CONCURRENTLY, alone in its statement, and a refused build does not fail boot', async () => {
    const first = await openPgMemDb();
    const proto = Object.getPrototypeOf(first);
    await first.close();
    const statements: string[] = [];
    const exec = proto.exec;
    vi.spyOn(proto, 'exec').mockImplementation(function (this: unknown, sql: string, ...rest: unknown[]) {
      statements.push(sql);
      return exec.call(this, sql, ...rest);
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    // pg-mem refuses CONCURRENTLY, as a real build can fail: boot must still succeed.
    const db = await openPgMemDb();
    await db.close();

    const building = statements.filter(s => /idx_events_org_item_type/.test(s));
    expect(building.length).toBeGreaterThan(0);
    for (const s of building) {
      expect(s).toMatch(/CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_org_item_type ON events\s*\(org_id, item_id, type\)/);
      // Alone: inside a multi-statement batch Postgres wraps it in a transaction,
      // where CONCURRENTLY is illegal and a plain build would lock the table.
      expect(s.trim().replace(/;\s*$/, '')).not.toContain(';');
    }
  });
});

describe('ensureEventsIndexConcurrently', () => {
  /** A Postgres-shaped adapter whose catalog says what the test needs. */
  const fake = (valid: boolean | null, failBuild = false) => {
    const statements: string[] = [];
    return {
      statements,
      db: {
        all: async (sql: string) => {
          statements.push(sql);
          return valid === null ? [] : [{ indisvalid: valid }];
        },
        exec: async (sql: string) => {
          statements.push(sql);
          if (failBuild && /^CREATE INDEX/.test(sql)) throw new Error('build failed');
        },
      } as any,
    };
  };
  const ensureEventsIndexConcurrently = (...a: [any, string, string]) => (pg as any).ensureEventsIndexConcurrently(...a);
  const SPEC = 'events(org_id, item_id, type)';

  it('builds a missing index concurrently', async () => {
    const f = fake(null);
    await ensureEventsIndexConcurrently(f.db, 'idx_x', SPEC);
    expect(f.statements.filter(s => !/pg_index/.test(s))).toEqual(['CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_x ON events(org_id, item_id, type)']);
  });

  it('leaves a valid index alone', async () => {
    const f = fake(true);
    await ensureEventsIndexConcurrently(f.db, 'idx_x', SPEC);
    expect(f.statements.some(s => /DROP|CREATE/.test(s))).toBe(false);
  });

  it('drops an INVALID index left by a failed build and builds it again - IF NOT EXISTS alone would keep it forever', async () => {
    const f = fake(false);
    await ensureEventsIndexConcurrently(f.db, 'idx_x', SPEC);
    const ddl = f.statements.filter(s => /DROP|CREATE/.test(s));
    expect(ddl).toEqual(['DROP INDEX CONCURRENTLY IF EXISTS idx_x', 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_x ON events(org_id, item_id, type)']);
  });

  it('a failed build never fails boot', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = fake(null, true);
    await expect(ensureEventsIndexConcurrently(f.db, 'idx_x', SPEC)).resolves.toBeUndefined();
  });

  it('says so when the catalog cannot be read or an INVALID index cannot be dropped, and still boots', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const noCatalog = { all: async () => { throw new Error('no catalog'); }, exec: async () => {} } as any;
    await ensureEventsIndexConcurrently(noCatalog, 'idx_x', SPEC);
    expect(warn.mock.calls.some(c => String(c[0]).includes('idx_x') && /catalog/.test(String(c[0])))).toBe(true);

    warn.mockClear();
    const stuck = { all: async () => [{ indisvalid: false }], exec: async (sql: string) => { if (/^DROP/.test(sql)) throw new Error('locked'); } } as any;
    await expect(ensureEventsIndexConcurrently(stuck, 'idx_x', SPEC)).resolves.toBeUndefined();
    expect(warn.mock.calls.some(c => String(c[0]).includes('idx_x') && /INVALID/.test(String(c[0])))).toBe(true);
  });
});
