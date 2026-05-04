import { describe, it, expect } from 'vitest';
import { toPostgres } from '../db/dialect';

describe('SQLite → Postgres dialect translator', () => {
  it('rewrites ? placeholders to $1, $2 ...', () => {
    const out = toPostgres('SELECT * FROM t WHERE a = ? AND b = ?');
    expect(out).toBe('SELECT * FROM t WHERE a = $1 AND b = $2');
  });

  it('does not rewrite ? inside string literals', () => {
    const out = toPostgres("SELECT '?', a FROM t WHERE x = ?");
    expect(out).toBe("SELECT '?', a FROM t WHERE x = $1");
  });

  it('rewrites INSERT OR IGNORE to ON CONFLICT DO NOTHING', () => {
    const out = toPostgres('INSERT OR IGNORE INTO orgs (id, name) VALUES (?, ?)');
    expect(out).toBe('INSERT INTO orgs (id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING');
  });

  it("rewrites datetime('now') to now()", () => {
    const out = toPostgres("UPDATE t SET ts = datetime('now') WHERE id = ?");
    expect(out).toBe('UPDATE t SET ts = now() WHERE id = $1');
  });

  it('rewrites date(col) to to_char(col::timestamptz, ...)', () => {
    const out = toPostgres('SELECT date(occurred_at) AS day FROM events');
    expect(out).toContain("to_char((occurred_at)::timestamptz, 'YYYY-MM-DD')");
  });

  it('rewrites strftime day-pattern to to_char', () => {
    const out = toPostgres("SELECT strftime('%Y-%m-%d', occurred_at) AS d FROM events");
    expect(out).toContain("to_char((occurred_at)::timestamptz, 'YYYY-MM-DD')");
  });

  it('rewrites strftime hour-pattern to to_char', () => {
    const out = toPostgres("SELECT strftime('%Y-%m-%dT%H:00', occurred_at) AS d FROM events");
    expect(out).toContain('to_char(');
    expect(out).toContain("'YYYY-MM-DD\"T\"HH24\":00\"'");
  });

  it('rewrites strftime with tz modifier to to_char(col + interval N min, ...)', () => {
    const out = toPostgres("SELECT strftime('%Y-%m-%d', occurred_at, ?) FROM events");
    // The ? becomes $1; the interval is built from that bind value
    expect(out).toContain("to_char((occurred_at)::timestamptz + ($1)::interval, 'YYYY-MM-DD')");
  });

  it('rewrites json_extract to #>> with a json path array', () => {
    const out = toPostgres("SELECT json_extract(payload, '$.payload.toStatus') FROM events");
    expect(out).toContain("(payload)::jsonb #>> '{payload,toStatus}'");
  });

  it('rewrites json_extract with array index in path', () => {
    const out = toPostgres("SELECT json_extract(payload, '$.payload.tokenUsage[0].input') FROM events");
    expect(out).toContain("(payload)::jsonb #>> '{payload,tokenUsage,0,input}'");
  });

  it('preserves ON CONFLICT(col) DO UPDATE clauses (PG-compatible already)', () => {
    const sql = `INSERT INTO kv(k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`;
    const out = toPostgres(sql);
    expect(out).toContain('ON CONFLICT(k) DO UPDATE SET');
    expect(out).toContain('excluded.v');
  });

  it('renumbers $-placeholders sequentially when ? appears multiple times', () => {
    const sql = `INSERT INTO t (a, b, c) VALUES (?, ?, ?) ON CONFLICT(a) DO UPDATE SET b = ?`;
    const out = toPostgres(sql);
    expect(out).toContain('VALUES ($1, $2, $3)');
    expect(out).toContain('SET b = $4');
  });
});
