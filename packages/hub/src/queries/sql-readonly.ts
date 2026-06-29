// Read-only SQL guard for the admin DB query console.
//
// The query console lets an admin run ad-hoc SQL against the hub's backing
// database. The security boundary is *read-only enforcement* + admin-only
// gating (see routes/db-console.ts) — NOT row-level org scoping, since we can't
// safely rewrite arbitrary user SQL. This module is the read-only spine: it
// rejects anything that could mutate data or schema, run multiple statements,
// or change session/transaction state.
//
// Approach: strip comments and string literals so keyword/structure checks only
// see real SQL tokens, then apply an allowlist (must start with SELECT/WITH) +
// denylist (no DML/DDL/PRAGMA/transaction-control keyword anywhere). Stripping
// strings/comments first means a forbidden word inside a string literal or a
// comment is harmless, and `\b` word boundaries mean `updated_at` / `deleted`
// columns don't trip the `UPDATE` / `DELETE` rules.

export interface ReadOnlyVerdict {
  ok: boolean;
  reason?: string;
}

// Keywords that can mutate data/schema, change session state, or run code.
// Matched as whole words (\b...\b) against the comment/string-stripped SQL.
const FORBIDDEN = [
  'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'UPSERT', 'MERGE',
  'DROP', 'CREATE', 'ALTER', 'TRUNCATE', 'RENAME',
  'GRANT', 'REVOKE',
  'ATTACH', 'DETACH', 'PRAGMA', 'VACUUM', 'REINDEX', 'ANALYZE',
  'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE',
  'CALL', 'EXEC', 'EXECUTE', 'COPY', 'SET', 'DO',
];

/**
 * Remove `-- line` comments, `/* block *​/` comments, and the contents of
 * single-quoted string literals (handling `''` escapes), so downstream checks
 * see only structural SQL. String literals collapse to `''` so token spacing
 * and statement boundaries are preserved.
 */
function stripCommentsAndStrings(sql: string): string {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];
    // line comment
    if (ch === '-' && next === '-') {
      i += 2;
      while (i < n && sql[i] !== '\n') i++;
      out += ' ';
      continue;
    }
    // block comment
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      continue;
    }
    // Postgres dollar-quoted string: $tag$ ... $tag$ (tag optional → $$ ... $$).
    // Collapse to '' so a ';' or keyword inside it isn't seen as real SQL.
    if (ch === '$') {
      const open = /^\$([A-Za-z_]\w*)?\$/.exec(sql.slice(i));
      if (open) {
        const delim = open[0];
        const close = sql.indexOf(delim, i + delim.length);
        i = close === -1 ? n : close + delim.length;
        out += "''";
        continue;
      }
    }
    // single-quoted string literal
    if (ch === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { i += 2; continue; } // escaped quote
          i++;
          break;
        }
        i++;
      }
      out += "''";
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Validate that `sql` is a single read-only statement. Returns { ok: true } for
 * a lone SELECT/CTE, otherwise { ok: false, reason }.
 */
export function validateReadOnlySql(sql: string): ReadOnlyVerdict {
  if (typeof sql !== 'string' || sql.trim() === '') {
    return { ok: false, reason: 'Query is empty.' };
  }

  const stripped = stripCommentsAndStrings(sql).trim();
  if (stripped === '') {
    return { ok: false, reason: 'Query is empty.' };
  }

  // Reject multiple statements: a semicolon that is not the final character
  // (after trimming) means there is a second statement.
  const withoutTrailing = stripped.replace(/;\s*$/, '');
  if (withoutTrailing.includes(';')) {
    return { ok: false, reason: 'Only a single statement is allowed.' };
  }

  // Must begin with SELECT or WITH (read-only CTE).
  const firstWord = withoutTrailing.match(/^\s*([a-zA-Z]+)/)?.[1]?.toUpperCase();
  if (firstWord !== 'SELECT' && firstWord !== 'WITH') {
    return { ok: false, reason: 'Only SELECT / WITH (read-only) queries are allowed.' };
  }

  // Denylist scan — catches data-modifying CTEs (WITH x AS (DELETE ...)) and
  // any other mutating/stateful keyword smuggled into an otherwise-SELECT query.
  for (const kw of FORBIDDEN) {
    const re = new RegExp(`\\b${kw}\\b`, 'i');
    if (re.test(withoutTrailing)) {
      return { ok: false, reason: `Disallowed keyword "${kw}" — only read-only queries are permitted.` };
    }
  }

  return { ok: true };
}

/**
 * Wrap a validated read-only query in a limited subselect so the database does
 * the row-capping rather than streaming an unbounded result into memory. The
 * caller fetches `limit` rows (typically `cap + 1`) to detect truncation.
 */
export function wrapWithLimit(sql: string, limit: number): string {
  const inner = sql.trim().replace(/;\s*$/, '');
  return `SELECT * FROM (${inner}) AS _agenfk_sub LIMIT ${limit}`;
}
