// Pure SQL-generation for the Visual Query Builder. Kept DOM-free so it can be
// unit-tested. The generated SQL is read-only by construction (SELECT only) and
// every identifier is validated + double-quoted, so the builder can't be used
// to smuggle in injection — and the server still re-validates on execute.

export type FilterOp = '=' | '!=' | '<' | '<=' | '>' | '>=' | 'LIKE' | 'IS NULL' | 'IS NOT NULL';
export type OrderDir = 'ASC' | 'DESC';

export interface BuilderFilter {
  column: string;
  op: FilterOp;
  value?: string | number;
}

export interface BuilderSpec {
  table: string;
  columns: string[];
  filters?: BuilderFilter[];
  orderBy?: { column: string; dir: OrderDir };
  limit?: number;
}

const VALID_OPS: ReadonlySet<string> = new Set(['=', '!=', '<', '<=', '>', '>=', 'LIKE', 'IS NULL', 'IS NOT NULL']);
const VALID_DIRS: ReadonlySet<string> = new Set(['ASC', 'DESC']);
const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Validate and double-quote a SQL identifier; throws on anything unsafe. */
export function quoteIdent(name: string): string {
  if (!SAFE_IDENT.test(name)) {
    throw new Error(`Unsafe identifier: ${JSON.stringify(name)}`);
  }
  return `"${name}"`;
}

/** Render a filter value: numbers pass through unquoted, strings become
 *  single-quoted literals with embedded quotes doubled. */
function renderValue(value: string | number | undefined): string {
  if (typeof value === 'number') return String(value);
  const s = String(value ?? '');
  return `'${s.replace(/'/g, "''")}'`;
}

function renderFilter(f: BuilderFilter): string {
  if (!VALID_OPS.has(f.op)) throw new Error(`Unsafe operator: ${JSON.stringify(f.op)}`);
  const col = quoteIdent(f.column);
  if (f.op === 'IS NULL' || f.op === 'IS NOT NULL') return `${col} ${f.op}`;
  return `${col} ${f.op} ${renderValue(f.value)}`;
}

/** Build a read-only SELECT statement from a builder spec. */
export function buildSelectSql(spec: BuilderSpec): string {
  const cols = spec.columns.length > 0
    ? spec.columns.map(quoteIdent).join(', ')
    : '*';
  let sql = `SELECT ${cols} FROM ${quoteIdent(spec.table)}`;

  if (spec.filters && spec.filters.length > 0) {
    sql += ' WHERE ' + spec.filters.map(renderFilter).join(' AND ');
  }
  if (spec.orderBy) {
    if (!VALID_DIRS.has(spec.orderBy.dir)) {
      throw new Error(`Unsafe order direction: ${JSON.stringify(spec.orderBy.dir)}`);
    }
    sql += ` ORDER BY ${quoteIdent(spec.orderBy.column)} ${spec.orderBy.dir}`;
  }
  if (typeof spec.limit === 'number' && Number.isFinite(spec.limit)) {
    sql += ` LIMIT ${Math.floor(spec.limit)}`;
  }
  return sql;
}
