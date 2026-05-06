import * as fs from 'fs';
import * as path from 'path';
import type { HubDb, Params, RunResult } from './types';
import { sanitizeRemoteUrl } from '../util/remoteUrl.js';

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
    revoked_at TEXT,
    installation_id TEXT,
    os_user TEXT,
    git_name TEXT,
    git_email TEXT
  );

  CREATE TABLE IF NOT EXISTS installations (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    os_user TEXT,
    git_name TEXT,
    git_email TEXT,
    agenfk_version TEXT,
    agenfk_version_updated_at TEXT
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

  CREATE TABLE IF NOT EXISTS flows (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    definition_json TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'hub' CHECK (source IN ('hub','community')),
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_by_user_id TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_flows_org ON flows(org_id);

  CREATE TABLE IF NOT EXISTS flow_assignments (
    org_id TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'org',
    target_id TEXT NOT NULL DEFAULT '',
    flow_id TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by_user_id TEXT,
    PRIMARY KEY (org_id, scope, target_id)
  );

  -- Fleet upgrade directives. Story 2 of EPIC 541c12b3 (remote upgrade).
  -- Each directive records an admin's intent to push a specific agenfk
  -- version to a scoped subset of installations. Per-installation delivery
  -- state lives in upgrade_directive_targets.
  CREATE TABLE IF NOT EXISTS upgrade_directives (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    target_version TEXT NOT NULL,
    scope_type TEXT NOT NULL,    -- 'all' | 'installation'
    scope_id TEXT,               -- installation_id when scope_type='installation', else NULL
    created_by_user_id TEXT,
    created_by_email TEXT,       -- denormalised audit field (Story 5)
    request_ip TEXT,             -- audit (Story 5)
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_upgrade_directives_org_time ON upgrade_directives(org_id, created_at);

  CREATE TABLE IF NOT EXISTS upgrade_directive_targets (
    directive_id TEXT NOT NULL,
    installation_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',   -- pending | in_progress | succeeded | failed | cancelled
    attempted_at TEXT,
    finished_at TEXT,
    result_version TEXT,
    error_message TEXT,
    PRIMARY KEY (directive_id, installation_id)
  );
  CREATE INDEX IF NOT EXISTS idx_udt_install_state ON upgrade_directive_targets(installation_id, state);
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

  // Backfill: canonicalise remote_url forms (ssh / https / with-or-without-.git)
  // so /v1/projects shows one chip per repo. Idempotent — rows already at the
  // canonical value are skipped. SQLite has no regex, so we transform in JS.
  {
    const distinct = raw.prepare(
      "SELECT DISTINCT remote_url FROM events WHERE remote_url IS NOT NULL AND remote_url <> ''"
    ).all() as Array<{ remote_url: string }>;
    const update = raw.prepare("UPDATE events SET remote_url = ? WHERE remote_url = ?");
    for (const { remote_url } of distinct) {
      const canonical = sanitizeRemoteUrl(remote_url);
      if (canonical !== remote_url) update.run(canonical, remote_url);
    }
  }

  // upgrade_directives audit columns — Story 5 of EPIC 541c12b3.
  const udCols = raw.prepare("PRAGMA table_info(upgrade_directives)").all() as Array<{ name: string }>;
  const udHave = new Set(udCols.map(c => c.name));
  if (udCols.length > 0) {
    if (!udHave.has('created_by_email')) raw.exec("ALTER TABLE upgrade_directives ADD COLUMN created_by_email TEXT");
    if (!udHave.has('request_ip'))      raw.exec("ALTER TABLE upgrade_directives ADD COLUMN request_ip TEXT");
  }

  // installations.agenfk_version + agenfk_version_updated_at — Story 7 of EPIC 541c12b3.
  const instCols = raw.prepare("PRAGMA table_info(installations)").all() as Array<{ name: string }>;
  const instHave = new Set(instCols.map(c => c.name));
  if (!instHave.has('agenfk_version')) raw.exec("ALTER TABLE installations ADD COLUMN agenfk_version TEXT");
  if (!instHave.has('agenfk_version_updated_at')) raw.exec("ALTER TABLE installations ADD COLUMN agenfk_version_updated_at TEXT");

  // api_keys columns added when binding installation identity to magic-link tokens.
  const akCols = raw.prepare("PRAGMA table_info(api_keys)").all() as Array<{ name: string }>;
  const akHave = new Set(akCols.map(c => c.name));
  if (!akHave.has('installation_id')) raw.exec("ALTER TABLE api_keys ADD COLUMN installation_id TEXT");
  if (!akHave.has('os_user'))         raw.exec("ALTER TABLE api_keys ADD COLUMN os_user TEXT");
  if (!akHave.has('git_name'))        raw.exec("ALTER TABLE api_keys ADD COLUMN git_name TEXT");
  if (!akHave.has('git_email'))       raw.exec("ALTER TABLE api_keys ADD COLUMN git_email TEXT");

  // flow_assignments multi-scope migration. Pre-existing tables had PK
  // (org_id, scope). New PK is (org_id, scope, target_id). SQLite can't
  // alter PK in place — recreate the table when needed.
  const faCols = raw.prepare("PRAGMA table_info(flow_assignments)").all() as Array<{ name: string }>;
  const faHave = new Set(faCols.map(c => c.name));
  if (faCols.length > 0 && !faHave.has('target_id')) {
    raw.exec(`
      BEGIN;
      CREATE TABLE flow_assignments_new (
        org_id TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'org',
        target_id TEXT NOT NULL DEFAULT '',
        flow_id TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_by_user_id TEXT,
        PRIMARY KEY (org_id, scope, target_id)
      );
      INSERT INTO flow_assignments_new (org_id, scope, target_id, flow_id, updated_at, updated_by_user_id)
        SELECT org_id, scope, '', flow_id, updated_at, updated_by_user_id FROM flow_assignments;
      DROP TABLE flow_assignments;
      ALTER TABLE flow_assignments_new RENAME TO flow_assignments;
      COMMIT;
    `);
  }

  raw.exec("CREATE INDEX IF NOT EXISTS idx_events_remote_time ON events(org_id, remote_url, occurred_at)");
  raw.exec("CREATE INDEX IF NOT EXISTS idx_events_item_type_time ON events(org_id, item_type, occurred_at)");
  raw.exec("CREATE INDEX IF NOT EXISTS idx_events_external_id ON events(org_id, external_id)");

  return new SqliteAdapter(raw);
}
