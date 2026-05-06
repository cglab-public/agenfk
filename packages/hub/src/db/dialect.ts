// SQLite → Postgres SQL dialect translator.
//
// The hub's call-site SQL is written in SQLite flavour (the original backend).
// The Postgres adapter routes every query through `toPostgres()` so we keep a
// single source of SQL while supporting both backends. The rewrites here are
// scoped to the patterns the hub actually uses; they are not a general-purpose
// SQLite-to-PG translator.

/**
 * Walk the SQL token-by-character respecting single-quoted string literals so
 * rewrites only touch real SQL syntax. Returns segments tagged as `code` or
 * `string` — string segments are passed through verbatim.
 */
function splitOnStrings(sql: string): Array<{ kind: 'code' | 'string'; text: string }> {
  const out: Array<{ kind: 'code' | 'string'; text: string }> = [];
  let i = 0;
  let buf = '';
  let inStr = false;
  while (i < sql.length) {
    const ch = sql[i];
    if (!inStr && ch === "'") {
      if (buf) out.push({ kind: 'code', text: buf });
      buf = "'";
      inStr = true;
      i++;
      continue;
    }
    if (inStr) {
      buf += ch;
      if (ch === "'") {
        // Handle escaped '' inside a string literal.
        if (sql[i + 1] === "'") { buf += "'"; i += 2; continue; }
        out.push({ kind: 'string', text: buf });
        buf = '';
        inStr = false;
      }
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  if (buf) out.push({ kind: inStr ? 'string' : 'code', text: buf });
  return out;
}

/** Replace `?` with `$1, $2, …` outside of string literals. */
function renumberPlaceholders(sql: string, startAt = 1): string {
  const parts = splitOnStrings(sql);
  let n = startAt;
  return parts.map(p => {
    if (p.kind === 'string') return p.text;
    return p.text.replace(/\?/g, () => `$${n++}`);
  }).join('');
}

/** INSERT OR IGNORE INTO ... → INSERT INTO ... ON CONFLICT DO NOTHING. */
function rewriteInsertOrIgnore(sql: string): string {
  // Match "INSERT OR IGNORE" at any case, then append "ON CONFLICT DO NOTHING"
  // before the trailing semicolon (or end of statement). We assume each call
  // is a single statement, which is true for every hub call site.
  if (!/\binsert\s+or\s+ignore\b/i.test(sql)) return sql;
  let out = sql.replace(/\binsert\s+or\s+ignore\b/gi, 'INSERT');
  // Append ON CONFLICT DO NOTHING if it isn't already there.
  if (!/\bon\s+conflict\b/i.test(out)) {
    out = out.trimEnd();
    if (out.endsWith(';')) {
      out = out.slice(0, -1) + ' ON CONFLICT DO NOTHING;';
    } else {
      out = out + ' ON CONFLICT DO NOTHING';
    }
  }
  return out;
}

/** datetime('now') → now(). */
function rewriteDatetimeNow(sql: string): string {
  return sql.replace(/\bdatetime\s*\(\s*'now'\s*\)/gi, 'now()');
}

/**
 * date(col) → to_char((col)::timestamptz, 'YYYY-MM-DD').
 * SQLite stores datetimes as ISO-8601 TEXT; PG as TIMESTAMPTZ. We cast and format
 * to a string so day-bucket comparisons against ISO date params keep working.
 */
function rewriteDate(sql: string): string {
  // Match date(<expr>) where <expr> is a balanced single argument with no nested parens
  // (true for every hub call site — they all pass a column).
  return sql.replace(/\bdate\s*\(\s*([a-zA-Z_][\w.]*)\s*\)/g,
    (_m, col) => `to_char((${col})::timestamptz, 'YYYY-MM-DD')`);
}

/**
 * strftime('%Y-%m-%d', col)               → to_char((col)::timestamptz, 'YYYY-MM-DD')
 * strftime('%Y-%m-%dT%H:00', col)         → to_char((col)::timestamptz, 'YYYY-MM-DD"T"HH24":00"')
 * strftime('...', col, $N)                → to_char((col)::timestamptz + ($N)::interval, '...')
 * Only the hub's two patterns are supported. Unknown formats fall through.
 */
function rewriteStrftime(sql: string): string {
  return sql.replace(
    /\bstrftime\s*\(\s*'([^']+)'\s*,\s*([a-zA-Z_][\w.]*)\s*(?:,\s*([^)]+))?\)/g,
    (_m, fmt, col, modifier) => {
      const pgFmt = fmt
        .replace(/%Y-%m-%dT%H:00/g, "YYYY-MM-DD\"T\"HH24\":00\"")
        .replace(/%Y-%m-%d/g, 'YYYY-MM-DD');
      const expr = modifier
        ? `(${col})::timestamptz + (${modifier.trim()})::interval`
        : `(${col})::timestamptz`;
      return `to_char(${expr}, '${pgFmt}')`;
    },
  );
}

/**
 * json_extract(col, '$.a.b[0].c') → (col)::jsonb #>> '{a,b,0,c}'
 * The JSON path syntax used by the hub is the simple subset SQLite supports:
 * dotted keys plus [N] array indices. Both translate to a flat #>> path array.
 */
function rewriteJsonExtract(sql: string): string {
  return sql.replace(
    /\bjson_extract\s*\(\s*([a-zA-Z_][\w.]*)\s*,\s*'\$([^']*)'\s*\)/g,
    (_m, col, jsonPath: string) => {
      // Convert a path like ".payload.tokenUsage[0].input" to ['payload','tokenUsage','0','input'].
      // Emit jsonb_extract_path_text rather than the #>> operator — both work
      // in real Postgres but jsonb_extract_path_text is also supported by
      // pg-mem natively, which we use in tests.
      const parts: string[] = [];
      const re = /\.([a-zA-Z_][\w]*)|\[(\d+)\]/g;
      let mm: RegExpExecArray | null;
      while ((mm = re.exec(jsonPath)) !== null) {
        parts.push(mm[1] ?? mm[2]);
      }
      const args = parts.map(p => `'${p}'`).join(', ');
      return `jsonb_extract_path_text((${col})::jsonb, ${args})`;
    },
  );
}

/**
 * Apply the full SQLite → Postgres rewrite chain. Order matters: ? renumbering
 * runs last so it covers placeholders introduced by INSERT OR IGNORE rewrite.
 */
export function toPostgres(sql: string): string {
  let out = sql;
  out = rewriteJsonExtract(out);
  out = rewriteStrftime(out);
  out = rewriteDate(out);
  out = rewriteDatetimeNow(out);
  out = rewriteInsertOrIgnore(out);
  out = renumberPlaceholders(out);
  return out;
}
