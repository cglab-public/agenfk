import type { HubDb, Params, RunResult } from './types';
import { toPostgres } from './dialect';

// `pg` is loaded lazily so installations that only use SQLite don't pay the
// require cost. The Pool / Client types are imported from `pg` directly.
import type { Pool, PoolClient, QueryResult } from 'pg';

const SCHEMA_PG = `
  CREATE TABLE IF NOT EXISTS orgs (
    id TEXT PRIMARY KEY,
    name TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    token_hash TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    label TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ
  );

  CREATE TABLE IF NOT EXISTS installations (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    first_seen TIMESTAMPTZ NOT NULL,
    last_seen TIMESTAMPTZ NOT NULL,
    os_user TEXT,
    git_name TEXT,
    git_email TEXT
  );

  CREATE TABLE IF NOT EXISTS events (
    event_id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    installation_id TEXT NOT NULL,
    user_key TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ NOT NULL,
    type TEXT NOT NULL,
    project_id TEXT,
    item_id TEXT,
    item_type TEXT,
    remote_url TEXT,
    item_title TEXT,
    external_id TEXT,
    payload TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_events_org_time ON events(org_id, occurred_at);
  CREATE INDEX IF NOT EXISTS idx_events_user_time ON events(org_id, user_key, occurred_at);
  CREATE INDEX IF NOT EXISTS idx_events_type_time ON events(org_id, type, occurred_at);

  CREATE TABLE IF NOT EXISTS rollups_daily (
    org_id TEXT NOT NULL,
    user_key TEXT NOT NULL,
    day TEXT NOT NULL,
    events_count INTEGER NOT NULL DEFAULT 0,
    items_closed INTEGER NOT NULL DEFAULT 0,
    tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0,
    validate_passes INTEGER NOT NULL DEFAULT 0,
    validate_fails INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (org_id, user_key, day)
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT,
    provider TEXT NOT NULL,
    provider_subject TEXT,
    role TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at TIMESTAMPTZ
  );

  CREATE TABLE IF NOT EXISTS device_codes (
    device_code TEXT PRIMARY KEY,
    user_code TEXT NOT NULL UNIQUE,
    org_id TEXT,
    token_hash TEXT,
    approved_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_device_codes_user_code ON device_codes(user_code);

  CREATE TABLE IF NOT EXISTS used_invites (
    nonce TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    used_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS auth_config (
    org_id TEXT PRIMARY KEY,
    password_enabled INTEGER NOT NULL DEFAULT 1,
    google_enabled INTEGER NOT NULL DEFAULT 0,
    google_client_id TEXT,
    google_client_secret_enc TEXT,
    entra_enabled INTEGER NOT NULL DEFAULT 0,
    entra_tenant_id TEXT,
    entra_client_id TEXT,
    entra_client_secret_enc TEXT,
    email_allowlist TEXT
  );
`;

/**
 * Per-instance state held by PgAdapter so we can route queries that run inside
 * a transaction to a single dedicated client (PG transactions are tied to a
 * connection, not a pool).
 */
interface PgState {
  pool: Pool;
  /** Set during `transaction()`; null otherwise. */
  txClient: PoolClient | null;
}

class PgAdapter implements HubDb {
  constructor(private state: PgState) {}

  private exec_(sql: string, params: Params): Promise<QueryResult<any>> {
    const text = toPostgres(sql);
    const values = params as unknown[];
    return this.state.txClient
      ? this.state.txClient.query(text, values)
      : this.state.pool.query(text, values);
  }

  async run(sql: string, params: Params = []): Promise<RunResult> {
    const r = await this.exec_(sql, params);
    return { changes: r.rowCount ?? 0 };
  }

  async get<T = unknown>(sql: string, params: Params = []): Promise<T | undefined> {
    const r = await this.exec_(sql, params);
    return r.rows[0] as T | undefined;
  }

  async all<T = unknown>(sql: string, params: Params = []): Promise<T[]> {
    const r = await this.exec_(sql, params);
    return r.rows as T[];
  }

  async exec(sql: string): Promise<void> {
    // Multi-statement DDL goes through pool.query directly without dialect
    // rewriting — schema bootstrap is already PG-flavoured. Raw exec callers
    // (the bootstrap and ad-hoc test helpers) own their dialect.
    if (this.state.txClient) await this.state.txClient.query(sql);
    else await this.state.pool.query(sql);
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state.txClient) {
      // Nested transactions aren't supported in v1 — the hub doesn't use them.
      throw new Error('PgAdapter: nested transactions are not supported');
    }
    const client = await this.state.pool.connect();
    this.state.txClient = client;
    try {
      await client.query('BEGIN');
      const result = await fn();
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* already rolled back */ }
      throw err;
    } finally {
      this.state.txClient = null;
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.state.pool.end();
  }
}

async function bootstrap(adapter: HubDb): Promise<void> {
  await adapter.exec(SCHEMA_PG);
  // Backfill columns on pre-existing event tables. Use information_schema so
  // legacy DBs created before the item_type/etc columns existed migrate cleanly.
  const cols = await adapter.all<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='events'"
  );
  const have = new Set(cols.map(c => c.column_name));
  if (!have.has('item_type'))   await adapter.exec("ALTER TABLE events ADD COLUMN item_type TEXT");
  if (!have.has('remote_url'))  await adapter.exec("ALTER TABLE events ADD COLUMN remote_url TEXT");
  if (!have.has('item_title')) await adapter.exec("ALTER TABLE events ADD COLUMN item_title TEXT");
  if (!have.has('external_id')) await adapter.exec("ALTER TABLE events ADD COLUMN external_id TEXT");
  await adapter.exec("CREATE INDEX IF NOT EXISTS idx_events_remote_time ON events(org_id, remote_url, occurred_at)");
  await adapter.exec("CREATE INDEX IF NOT EXISTS idx_events_item_type_time ON events(org_id, item_type, occurred_at)");
  await adapter.exec("CREATE INDEX IF NOT EXISTS idx_events_external_id ON events(org_id, external_id)");
}

export async function openPgDb(connectionString: string): Promise<HubDb> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Pool } = require('pg') as typeof import('pg');
  const pool = new Pool({ connectionString });
  // Probe the connection so we fail fast with a clear error rather than
  // surfacing the failure on the first query.
  try {
    const client = await pool.connect();
    client.release();
  } catch (err) {
    await pool.end().catch(() => {});
    throw new Error(`Cannot connect to Postgres at ${redactDsn(connectionString)}: ${(err as Error).message}`);
  }
  const state: PgState = { pool, txClient: null };
  const adapter = new PgAdapter(state);
  await bootstrap(adapter);
  return adapter;
}

/** Test-only entry point: spin up an in-process pg-mem instance. */
export async function openPgMemDb(): Promise<HubDb> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { newDb, DataType } = require('pg-mem') as typeof import('pg-mem');
  const memDb = newDb({ autoCreateForeignKeyIndices: true });
  registerPgMemPolyfills(memDb, DataType);
  const { Pool } = memDb.adapters.createPg();
  const pool = new Pool() as unknown as Pool;
  const state: PgState = { pool, txClient: null };
  const adapter = new PgAdapter(state);
  await bootstrap(adapter);
  return adapter;
}

/**
 * pg-mem ships only a small subset of Postgres' native functions. Register the
 * ones the hub's call-site SQL needs (after dialect translation) so the same
 * queries that run on real PG also run under pg-mem in tests.
 */
function registerPgMemPolyfills(memDb: any, DataType: any): void {
  // to_char(timestamptz, fmt) — the only patterns the hub emits are
  // 'YYYY-MM-DD' and 'YYYY-MM-DD"T"HH24":00"'. Implement them straight rather
  // than parsing arbitrary PG format strings.
  const toChar = (ts: Date, fmt: string): string => {
    const d = ts instanceof Date ? ts : new Date(ts);
    const Y = d.getUTCFullYear().toString().padStart(4, '0');
    const M = (d.getUTCMonth() + 1).toString().padStart(2, '0');
    const D = d.getUTCDate().toString().padStart(2, '0');
    const H = d.getUTCHours().toString().padStart(2, '0');
    if (fmt === 'YYYY-MM-DD') return `${Y}-${M}-${D}`;
    if (fmt === 'YYYY-MM-DD"T"HH24":00"') return `${Y}-${M}-${D}T${H}:00`;
    return d.toISOString();
  };
  memDb.public.registerFunction({
    name: 'to_char',
    args: [DataType.timestamptz, DataType.text],
    returns: DataType.text,
    implementation: toChar,
    impure: false,
  });
  // jsonb_extract_path_text(jsonb, VARIADIC text[]) — pg-mem doesn't ship this,
  // so we register one variant per arity the hub actually emits (2 and 4).
  const extractPath = (jb: any, ...keys: string[]): string | null => {
    let cur: any = jb;
    for (const k of keys) {
      if (cur == null) return null;
      // pg-mem hands us already-parsed JSON for jsonb columns
      if (Array.isArray(cur)) {
        const idx = Number(k);
        cur = Number.isFinite(idx) ? cur[idx] : undefined;
      } else if (typeof cur === 'object') {
        cur = cur[k];
      } else {
        return null;
      }
    }
    if (cur == null) return null;
    return typeof cur === 'string' ? cur : String(cur);
  };
  for (let arity = 1; arity <= 6; arity++) {
    memDb.public.registerFunction({
      name: 'jsonb_extract_path_text',
      args: [DataType.jsonb, ...Array(arity).fill(DataType.text)],
      returns: DataType.text,
      implementation: extractPath,
      impure: false,
    });
  }
  // pg-mem's interval addition support is patchy. Implement it as a
  // string-arg function: timestamptz + (text)::interval where text is "+N
  // minutes" or "-N minutes". The hub only uses minute-shifts.
  memDb.public.registerOperator?.({
    operator: '+',
    left: DataType.timestamptz,
    right: DataType.text,
    returns: DataType.timestamptz,
    implementation: (ts: Date, intervalText: string) => {
      const m = /^([+-]?\d+)\s+minutes?$/i.exec(String(intervalText).trim());
      if (!m) return ts;
      const minutes = Number(m[1]);
      return new Date(ts.getTime() + minutes * 60_000);
    },
  });
}

function redactDsn(dsn: string): string {
  // postgres://user:pass@host:port/db → postgres://user:***@host:port/db
  return dsn.replace(/(:\/\/[^:@/]+:)[^@/]+(@)/, '$1***$2');
}
