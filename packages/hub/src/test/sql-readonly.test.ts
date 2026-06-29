import { describe, it, expect } from 'vitest';
import { validateReadOnlySql, wrapWithLimit } from '../queries/sql-readonly';

describe('validateReadOnlySql', () => {
  const ok = (sql: string) => expect(validateReadOnlySql(sql).ok).toBe(true);
  const bad = (sql: string) => expect(validateReadOnlySql(sql).ok).toBe(false);

  it('accepts a plain SELECT', () => ok('SELECT * FROM users'));
  it('accepts lowercase select', () => ok('select id from events where org_id = \'x\''));
  it('accepts a read-only CTE', () => ok('WITH t AS (SELECT 1 AS n) SELECT * FROM t'));
  it('accepts a trailing semicolon', () => ok('SELECT 1;'));
  it('accepts leading line comments', () => ok('-- a comment\nSELECT 1'));
  it('accepts leading block comments', () => ok('/* hi */ SELECT 1'));

  it('rejects empty / whitespace', () => { bad(''); bad('   \n  '); });

  it('rejects writes (INSERT/UPDATE/DELETE)', () => {
    bad('INSERT INTO users (id) VALUES (1)');
    bad('UPDATE users SET role = \'admin\'');
    bad('DELETE FROM users');
  });

  it('rejects DDL (DROP/CREATE/ALTER/TRUNCATE)', () => {
    bad('DROP TABLE users');
    bad('CREATE TABLE x (id TEXT)');
    bad('ALTER TABLE users ADD COLUMN x TEXT');
    bad('TRUNCATE users');
  });

  it('rejects PRAGMA / ATTACH / VACUUM / transaction control', () => {
    bad('PRAGMA table_info(users)');
    bad("ATTACH DATABASE 'other.db' AS o");
    bad('VACUUM');
    bad('BEGIN');
    bad('COMMIT');
  });

  it('rejects multiple statements', () => {
    bad('SELECT 1; DELETE FROM users');
    bad('SELECT 1; SELECT 2');
  });

  it('rejects a data-modifying CTE', () => {
    bad('WITH x AS (DELETE FROM users RETURNING *) SELECT * FROM x');
  });

  it('does NOT false-positive on forbidden keywords inside string literals', () => {
    ok("SELECT 'delete me' AS note");
    ok("SELECT 'drop; create' AS note FROM orgs");
  });

  it('does NOT false-positive on forbidden keywords as substrings of identifiers', () => {
    ok('SELECT updated_at, created_at FROM flows');
    ok('SELECT deleted_count FROM rollups_daily');
  });

  it('ignores a forbidden keyword that only appears in a comment', () => {
    ok('SELECT 1 -- ; DROP TABLE users');
    ok('SELECT 1 /* ; DROP TABLE users */');
  });

  it('accepts a semicolon inside a string literal (single statement)', () => {
    ok("SELECT ';' AS x");
  });

  it('does not false-positive on Postgres dollar-quoted strings', () => {
    ok('SELECT $$O\'Brien$$ AS x');
    ok('SELECT $$ ; DROP TABLE users $$ AS note FROM orgs');
    ok('SELECT $tag$ delete me $tag$ AS note');
  });
});

describe('wrapWithLimit', () => {
  it('wraps the query in a limited subselect', () => {
    expect(wrapWithLimit('SELECT * FROM t', 100))
      .toBe('SELECT * FROM (SELECT * FROM t) AS _agenfk_sub LIMIT 100');
  });
  it('strips a trailing semicolon before wrapping', () => {
    expect(wrapWithLimit('SELECT 1;', 5))
      .toBe('SELECT * FROM (SELECT 1) AS _agenfk_sub LIMIT 5');
  });
});
