import { describe, it, expect } from 'vitest';
import { buildSelectSql, quoteIdent } from '../queryBuilder';

describe('quoteIdent', () => {
  it('double-quotes a valid identifier', () => {
    expect(quoteIdent('users')).toBe('"users"');
    expect(quoteIdent('created_at')).toBe('"created_at"');
  });
  it('throws on an unsafe identifier', () => {
    expect(() => quoteIdent('bad"name')).toThrow();
    expect(() => quoteIdent('drop table')).toThrow();
    expect(() => quoteIdent('')).toThrow();
  });
});

describe('buildSelectSql', () => {
  it('selects all columns when none chosen', () => {
    expect(buildSelectSql({ table: 'users', columns: [] }))
      .toBe('SELECT * FROM "users"');
  });
  it('selects the chosen columns', () => {
    expect(buildSelectSql({ table: 'users', columns: ['id', 'email'] }))
      .toBe('SELECT "id", "email" FROM "users"');
  });
  it('adds a string equality filter (quoted + escaped)', () => {
    expect(buildSelectSql({ table: 'users', columns: [], filters: [{ column: 'role', op: '=', value: 'admin' }] }))
      .toBe('SELECT * FROM "users" WHERE "role" = \'admin\'');
    expect(buildSelectSql({ table: 'users', columns: [], filters: [{ column: 'name', op: '=', value: "O'Brien" }] }))
      .toBe('SELECT * FROM "users" WHERE "name" = \'O\'\'Brien\'');
  });
  it('leaves numeric filter values unquoted', () => {
    expect(buildSelectSql({ table: 'events', columns: [], filters: [{ column: 'n', op: '>', value: 5 }] }))
      .toBe('SELECT * FROM "events" WHERE "n" > 5');
  });
  it('supports IS NULL / IS NOT NULL with no value', () => {
    expect(buildSelectSql({ table: 'users', columns: [], filters: [{ column: 'last_login_at', op: 'IS NULL' }] }))
      .toBe('SELECT * FROM "users" WHERE "last_login_at" IS NULL');
  });
  it('joins multiple filters with AND', () => {
    expect(buildSelectSql({
      table: 'events', columns: ['type'],
      filters: [{ column: 'org_id', op: '=', value: 'org' }, { column: 'type', op: 'LIKE', value: 'pr.%' }],
    })).toBe('SELECT "type" FROM "events" WHERE "org_id" = \'org\' AND "type" LIKE \'pr.%\'');
  });
  it('adds ORDER BY and LIMIT', () => {
    expect(buildSelectSql({ table: 'events', columns: [], orderBy: { column: 'occurred_at', dir: 'DESC' }, limit: 50 }))
      .toBe('SELECT * FROM "events" ORDER BY "occurred_at" DESC LIMIT 50');
  });
  it('rejects an unsafe order direction', () => {
    expect(() => buildSelectSql({ table: 'events', columns: [], orderBy: { column: 'x', dir: 'DROP' as any } }))
      .toThrow();
  });
  it('rejects an unsafe filter operator', () => {
    expect(() => buildSelectSql({ table: 'users', columns: [], filters: [{ column: 'x', op: 'UNION' as any, value: 1 }] }))
      .toThrow();
  });
});
