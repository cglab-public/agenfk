import * as fs from 'fs';
import * as path from 'path';
import type { HubDb, Params, RunResult } from './types';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
type RawDb = InstanceType<typeof DatabaseSync>;

const SCHEMA_SQLITE = `
  CREATE TABLE IF NOT EXISTS orgs (
    id TEXT PRIMARY KEY,
    name TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    token_hash TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    label TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    revoked_at TEXT
  );

  CREATE TABLE IF NOT EXISTS installations (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    os_user TEXT,
    git_name TEXT,
    git_email TEXT
  );

  CREATE TABLE IF NOT EXISTS events (
    event_id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    installation_id TEXT NOT NULL,
    user_key TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    received_at TEXT NOT NULL,
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
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_login_at TEXT
  );

  CREATE TABLE IF NOT EXISTS device_codes (
    device_code TEXT PRIMARY KEY,
    user_code TEXT NOT NULL UNIQUE,
    org_id TEXT,
    token_hash TEXT,
    approved_at TEXT,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_device_codes_user_code ON device_codes(user_code);

  CREATE TABLE IF NOT EXISTS used_invites (
    nonce TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    used_at TEXT NOT NULL DEFAULT (datetime('now'))
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

class SqliteAdapter implements HubDb {
  constructor(private raw: RawDb) {}

  async run(sql: string, params: Params = []): Promise<RunResult> {
    const stmt = this.raw.prepare(sql);
    const r = stmt.run(...(params as any[]));
    return {
      changes: Number(r.changes ?? 0),
      lastInsertRowid: r.lastInsertRowid as number | bigint | undefined,
    };
  }

  async get<T = unknown>(sql: string, params: Params = []): Promise<T | undefined> {
    const stmt = this.raw.prepare(sql);
    return stmt.get(...(params as any[])) as T | undefined;
  }

  async all<T = unknown>(sql: string, params: Params = []): Promise<T[]> {
    const stmt = this.raw.prepare(sql);
    return stmt.all(...(params as any[])) as T[];
  }

  async exec(sql: string): Promise<void> {
    this.raw.exec(sql);
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    this.raw.exec('BEGIN');
    try {
      const result = await fn();
      this.raw.exec('COMMIT');
      return result;
    } catch (err) {
      try { this.raw.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw err;
    }
  }

  async close(): Promise<void> {
    this.raw.close();
  }

  /** Escape hatch for SQLite-specific tooling (PRAGMA inspections, etc). Avoid in route code. */
  __raw(): RawDb {
    return this.raw;
  }
}

export async function openSqliteDb(dbPath: string): Promise<HubDb> {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const raw = new DatabaseSync(dbPath);
  raw.prepare('PRAGMA journal_mode = WAL').run();
  raw.prepare('PRAGMA foreign_keys = ON').run();
  raw.exec(SCHEMA_SQLITE);

  // Backfill columns on pre-existing event tables created before
  // item_type/remote_url/item_title/external_id existed.
  const cols = raw.prepare("PRAGMA table_info(events)").all() as Array<{ name: string }>;
  const have = new Set(cols.map(c => c.name));
  if (!have.has('item_type'))  raw.exec("ALTER TABLE events ADD COLUMN item_type TEXT");
  if (!have.has('remote_url')) raw.exec("ALTER TABLE events ADD COLUMN remote_url TEXT");
  if (!have.has('item_title')) raw.exec("ALTER TABLE events ADD COLUMN item_title TEXT");
  if (!have.has('external_id')) raw.exec("ALTER TABLE events ADD COLUMN external_id TEXT");
  raw.exec("CREATE INDEX IF NOT EXISTS idx_events_remote_time ON events(org_id, remote_url, occurred_at)");
  raw.exec("CREATE INDEX IF NOT EXISTS idx_events_item_type_time ON events(org_id, item_type, occurred_at)");
  raw.exec("CREATE INDEX IF NOT EXISTS idx_events_external_id ON events(org_id, external_id)");

  return new SqliteAdapter(raw);
}
