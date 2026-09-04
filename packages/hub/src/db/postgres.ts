import { AsyncLocalStorage } from 'async_hooks';
import type { HubDb, Params, RunResult } from './types';
import { toPostgres } from './dialect';
import { sanitizeRemoteUrl, remoteUrlFromRepo } from '../util/remoteUrl.js';

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
    revoked_at TIMESTAMPTZ,
    installation_id TEXT,
    os_user TEXT,
    git_name TEXT,
    git_email TEXT
  );

  -- agenfk_version + agenfk_version_updated_at added in Story 7 of EPIC 541c12b3.
  CREATE TABLE IF NOT EXISTS installations (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    first_seen TIMESTAMPTZ NOT NULL,
    last_seen TIMESTAMPTZ NOT NULL,
    os_user TEXT,
    git_name TEXT,
    git_email TEXT,
    agenfk_version TEXT,
    agenfk_version_updated_at TIMESTAMPTZ,
    retired_at TIMESTAMPTZ,
    retired_by_user_id TEXT,
    retired_by_email TEXT
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
    reporting_version TEXT,
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
    prs_opened INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (org_id, user_key, day)
  );
  CREATE INDEX IF NOT EXISTS idx_rollups_org_day_user ON rollups_daily(org_id, day, user_key);

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
    -- Identity of the machine that started this code, so the token can be
    -- BOUND when it is issued at approve time. Without it the device flow
    -- produced an unbound key, and an unbound key is never handed a fleet
    -- directive — the install went permanently invisible. (BUG 159360db.)
    installation_id TEXT,
    os_user TEXT,
    git_name TEXT,
    git_email TEXT,
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

  CREATE TABLE IF NOT EXISTS flows (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    definition_json TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'hub' CHECK (source IN ('hub','community')),
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by_user_id TEXT,
    org_available INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_flows_org ON flows(org_id);

  CREATE TABLE IF NOT EXISTS flow_assignments (
    org_id TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'org',
    target_id TEXT NOT NULL DEFAULT '',
    flow_id TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by_user_id TEXT,
    PRIMARY KEY (org_id, scope, target_id)
  );

  CREATE TABLE IF NOT EXISTS upgrade_directives (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    target_version TEXT NOT NULL,
    scope_type TEXT NOT NULL,
    scope_id TEXT,
    created_by_user_id TEXT,
    created_by_email TEXT,
    request_ip TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ
  );
  CREATE INDEX IF NOT EXISTS idx_upgrade_directives_org_time ON upgrade_directives(org_id, created_at);

  CREATE TABLE IF NOT EXISTS upgrade_directive_targets (
    directive_id TEXT NOT NULL,
    installation_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',  -- pending | in_progress | succeeded | failed | cancelled
    attempted_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    result_version TEXT,
    error_message TEXT,
    PRIMARY KEY (directive_id, installation_id)
  );
  CREATE INDEX IF NOT EXISTS idx_udt_install_state ON upgrade_directive_targets(installation_id, state);

  CREATE TABLE IF NOT EXISTS system_state (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  -- First-run admin bootstrap. See packages/hub/src/auth/bootstrapToken.ts.
  CREATE TABLE IF NOT EXISTS bootstrap_tokens (
    token TEXT PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  -- People hidden by an admin (CGLAB-31). See the SQLite schema for the
  -- full rationale — selection surfaces only, historical data untouched,
  -- reversible by row delete.
  -- Audit trail for identity merges (CGLAB-65). A merge rewrites history, so
  -- who did it, when, and how much moved must be recoverable afterwards.
  -- Repoint campaigns (CGLAB-66). A hub can change DNS name without anyone
  -- rejoining, because clients hold only {url, token, orgId} and keys are
  -- org-scoped. What was missing is push-down: a campaign tells connected
  -- installations to move, and the per-target rows are what make it safe to
  -- drop the old name once every one of them has confirmed ON the new name.
  CREATE TABLE IF NOT EXISTS repoint_campaigns (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    target_url TEXT NOT NULL,
    allowed_host TEXT NOT NULL,
    created_by_user_id TEXT,
    created_by_email TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at TIMESTAMPTZ
  );
  CREATE INDEX IF NOT EXISTS idx_repoint_campaigns_org ON repoint_campaigns(org_id, created_at);

  CREATE TABLE IF NOT EXISTS repoint_campaign_targets (
    campaign_id TEXT NOT NULL,
    installation_id TEXT NOT NULL,
    -- pending | succeeded | blocked_by_env | failed | cancelled
    state TEXT NOT NULL DEFAULT 'pending',
    attempted_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    reported_url TEXT,
    error_message TEXT,
    PRIMARY KEY (campaign_id, installation_id)
  );
  CREATE INDEX IF NOT EXISTS idx_rct_install_state ON repoint_campaign_targets(installation_id, state);

  -- What each identity merge actually moved (BUG 098f8ba7). The audit row
  -- recorded only counts, so a mistaken merge — attributing one person's work to
  -- another — was permanent. A journal rather than a column on events, because a
  -- single slot is overwritten by the next merge and a chain could then never be
  -- unwound past one step.
  CREATE TABLE IF NOT EXISTS user_key_merge_events (
    merge_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    previous_user_key TEXT NOT NULL,
    PRIMARY KEY (merge_id, event_id)
  );
  CREATE INDEX IF NOT EXISTS idx_ukme_merge ON user_key_merge_events(merge_id);

  CREATE TABLE IF NOT EXISTS user_key_merges (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    from_user_key TEXT NOT NULL,
    to_user_key TEXT NOT NULL,
    events_moved INTEGER NOT NULL DEFAULT 0,
    merged_by_user_id TEXT,
    merged_by_email TEXT,
    reverted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  -- Where a merged-away identity went (CGLAB-72). See the SQLite schema for the
  -- reasoning: ingest resolves through this so a machine waking after the
  -- liveness window cannot resurrect a key its merge retired.
  CREATE TABLE IF NOT EXISTS user_key_aliases (
    org_id TEXT NOT NULL,
    alias_key TEXT NOT NULL,
    canonical_key TEXT NOT NULL,
    merge_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, alias_key)
  );
  CREATE INDEX IF NOT EXISTS idx_user_key_aliases_merge ON user_key_aliases(merge_id);

  CREATE TABLE IF NOT EXISTS hidden_users (
    org_id TEXT NOT NULL,
    user_key TEXT NOT NULL,
    hidden_by_user_id TEXT,
    hidden_by_email TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, user_key)
  );

  -- Admin-curated model identity; see the SQLite schema for the reasoning
  -- (literal canonical name by choice, read-time only, events untouched).
  CREATE TABLE IF NOT EXISTS model_mappings (
    org_id TEXT NOT NULL,
    alias_model TEXT NOT NULL,
    canonical_model TEXT NOT NULL,
    created_by_user_id TEXT,
    created_by_email TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, alias_model)
  );
  CREATE INDEX IF NOT EXISTS idx_model_mappings_canonical
    ON model_mappings(org_id, canonical_model);

  -- Admin-curated provider + license class per model (CGLAB-133 follow-up).
  -- Mirrors the SQLite DDL; see the comment there for why this is keyed per
  -- artifact and matched by prefix rather than per family.
  CREATE TABLE IF NOT EXISTS model_meta (
    org_id TEXT NOT NULL,
    model TEXT NOT NULL,
    provider TEXT NOT NULL,
    license_class TEXT NOT NULL CHECK (license_class IN ('open_weights','commercial')),
    license TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'seed' CHECK (source IN ('seed','admin')),
    updated_by_user_id TEXT,
    updated_by_email TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, model)
  );
`;

/**
 * Per-instance state held by PgAdapter. The transaction client is deliberately
 * NOT here: see txStorage.
 */
interface PgState {
  pool: Pool;
}

/**
 * The client backing the transaction the CURRENT async context is inside, if
 * any. A PG transaction is tied to a connection rather than a pool, so its
 * statements must all use one client — but scoping that client to the adapter
 * meant every concurrent request's statements joined whatever transaction
 * happened to be open, and a rollback in an admin operation silently discarded
 * unrelated event ingest that ran during it. (BUG c5e8b847.)
 *
 * AsyncLocalStorage propagates through the awaits inside the transaction
 * callback and nowhere else, which is exactly the boundary we want.
 */
const txStorage = new AsyncLocalStorage<PoolClient>();

class PgAdapter implements HubDb {
  constructor(private state: PgState) {}

  private exec_(sql: string, params: Params): Promise<QueryResult<any>> {
    const text = toPostgres(sql);
    const values = params as unknown[];
    const tx = txStorage.getStore();
    return tx
      ? tx.query(text, values)
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
    const tx = txStorage.getStore();
    if (tx) await tx.query(sql);
    else await this.state.pool.query(sql);
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (txStorage.getStore()) {
      // Nested transactions aren't supported in v1 — the hub doesn't use them.
      throw new Error('PgAdapter: nested transactions are not supported');
    }
    const client = await this.state.pool.connect();
    try {
      await client.query('BEGIN');
      // Run the callback INSIDE the async-context scope, so only its own
      // statements reach this client. Concurrent work stays on the pool.
      const result = await txStorage.run(client, fn);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* already rolled back */ }
      throw err;
    } finally {
      // Nothing to unset: the client's visibility ended with the async scope.
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.state.pool.end();
  }
}

// Backfill: PR events ingested before the repo→remote_url fallback existed have
// remote_url = NULL, stranding their repo inside the payload JSON and hiding
// them from the projects filter. Derive remote_url from payload.repo the same
// way the ingestion path now does. Parsed JS-side so this stays identical to the
// SQLite backfill and avoids jsonb casting on TEXT payloads. Idempotent (only
// touches null/empty PR rows) and exported so tests can exercise it against a
// pg-mem adapter without re-running the (non-reentrant on pg-mem) full schema.
export async function backfillPrEventRemoteUrls(adapter: HubDb): Promise<void> {
  const prRows = await adapter.all<{ event_id: string; payload: string }>(
    "SELECT event_id, payload FROM events WHERE (remote_url IS NULL OR remote_url = '') AND type IN ('pr.opened', 'pr.updated')"
  );
  for (const { event_id, payload } of prRows) {
    let repo: unknown;
    try { repo = JSON.parse(payload)?.payload?.repo; } catch { continue; }
    if (typeof repo !== 'string') continue;
    const derived = remoteUrlFromRepo(repo);
    if (derived) {
      await adapter.run("UPDATE events SET remote_url = ? WHERE event_id = ?", [sanitizeRemoteUrl(derived), event_id]);
    }
  }
}

async function bootstrap(adapter: HubDb): Promise<void> {
  await adapter.exec(SCHEMA_PG);
  await adapter.exec("DELETE FROM events WHERE type = 'tokens.logged'");
  await adapter.exec("DELETE FROM rollups_daily");
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
  // events.reporting_version — captures the X-Agenfk-Version header that
  // delivered each event, so the admin Recent Events view can show stuck-
  // process drift (recent events still tagged with old version after upgrade).
  if (!have.has('reporting_version')) await adapter.exec("ALTER TABLE events ADD COLUMN reporting_version TEXT");
  // rollups_daily.prs_opened — added with the PR metrics initiative.
  const rdCols = await adapter.all<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'rollups_daily'`
  );
  const rdHave = new Set(rdCols.map(c => c.column_name));
  if (!rdHave.has('prs_opened')) await adapter.exec("ALTER TABLE rollups_daily ADD COLUMN prs_opened INTEGER NOT NULL DEFAULT 0");

  await adapter.exec("CREATE INDEX IF NOT EXISTS idx_events_remote_time ON events(org_id, remote_url, occurred_at)");
  await adapter.exec("CREATE INDEX IF NOT EXISTS idx_events_item_type_time ON events(org_id, item_type, occurred_at)");
  await adapter.exec("CREATE INDEX IF NOT EXISTS idx_events_external_id ON events(org_id, external_id)");
  await adapter.exec("CREATE INDEX IF NOT EXISTS idx_rollups_org_day_user ON rollups_daily(org_id, day, user_key)");

  // BUG ab9b39d3: backs the Admin -> Flows lookup of the latest remote_url per
  // project. CONCURRENTLY, and deliberately NOT inside SCHEMA_PG: that batch is
  // one multi-statement simple query, so Postgres wraps it in an implicit
  // transaction, and a plain CREATE INDEX there would hold a SHARE lock on the
  // events ingestion table — blocking every insert — until the whole batch
  // commits. Each standalone exec() is its own implicit transaction, where
  // CONCURRENTLY is legal. A failed concurrent build leaves an INVALID index
  // that is simply rebuilt on the next boot, so don't fail boot over it.
  try {
    await adapter.exec("CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_org_project_time ON events(org_id, project_id, occurred_at)");
  } catch (e) {
    console.warn('[hub] idx_events_org_project_time build skipped:', (e as Error)?.message);
  }

  // Canonicalise events.remote_url so the projects filter in the hub UI
  // doesn't show duplicates for repos expressed as ssh / https / with-or-
  // without-.git. Idempotent — already-canonical rows are skipped.
  {
    const distinct = await adapter.all<{ remote_url: string }>(
      "SELECT DISTINCT remote_url FROM events WHERE remote_url IS NOT NULL AND remote_url <> ''"
    );
    for (const { remote_url } of distinct) {
      const canonical = sanitizeRemoteUrl(remote_url);
      if (canonical !== remote_url) {
        await adapter.run(
          "UPDATE events SET remote_url = ? WHERE remote_url = ?",
          [canonical, remote_url],
        );
      }
    }
  }

  // PR-event remote_url backfill (see backfillPrEventRemoteUrls).
  await backfillPrEventRemoteUrls(adapter);

  // upgrade_directives audit columns — Story 5 of EPIC 541c12b3.
  const udCols = await adapter.all<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='upgrade_directives'"
  );
  const udHave = new Set(udCols.map(c => c.column_name));
  if (udCols.length > 0) {
    if (!udHave.has('created_by_email')) await adapter.exec("ALTER TABLE upgrade_directives ADD COLUMN created_by_email TEXT");
    if (!udHave.has('request_ip'))      await adapter.exec("ALTER TABLE upgrade_directives ADD COLUMN request_ip TEXT");
  }

  // installations.agenfk_version + agenfk_version_updated_at — Story 7 of EPIC 541c12b3.
  const instCols = await adapter.all<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='installations'"
  );
  const instHave = new Set(instCols.map(c => c.column_name));
  if (!instHave.has('agenfk_version')) await adapter.exec("ALTER TABLE installations ADD COLUMN agenfk_version TEXT");
  if (!instHave.has('agenfk_version_updated_at')) await adapter.exec("ALTER TABLE installations ADD COLUMN agenfk_version_updated_at TIMESTAMPTZ");

  // installations retirement columns — CGLAB-64. See the sqlite adapter for rationale.
  if (!instHave.has('retired_at')) await adapter.exec("ALTER TABLE installations ADD COLUMN retired_at TIMESTAMPTZ");
  if (!instHave.has('retired_by_user_id')) await adapter.exec("ALTER TABLE installations ADD COLUMN retired_by_user_id TEXT");
  if (!instHave.has('retired_by_email')) await adapter.exec("ALTER TABLE installations ADD COLUMN retired_by_email TEXT");

  // api_keys columns added when binding installation identity to magic-link tokens.
  const akCols = await adapter.all<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='api_keys'"
  );
  const akHave = new Set(akCols.map(c => c.column_name));
  // user_key_merges.reverted_at — BUG 098f8ba7.
  const ukmCols = await adapter.all<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'user_key_merges'",
  );
  if (ukmCols.length > 0 && !new Set(ukmCols.map(c => c.column_name)).has('reverted_at')) {
    await adapter.exec("ALTER TABLE user_key_merges ADD COLUMN reverted_at TIMESTAMPTZ");
  }

  // device_codes identity columns — BUG 159360db. See the sqlite adapter.
  const dcCols = await adapter.all<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'device_codes'",
  );
  const dcHave = new Set(dcCols.map(c => c.column_name));
  if (dcCols.length > 0) {
    if (!dcHave.has('installation_id')) await adapter.exec("ALTER TABLE device_codes ADD COLUMN installation_id TEXT");
    if (!dcHave.has('os_user'))         await adapter.exec("ALTER TABLE device_codes ADD COLUMN os_user TEXT");
    if (!dcHave.has('git_name'))        await adapter.exec("ALTER TABLE device_codes ADD COLUMN git_name TEXT");
    if (!dcHave.has('git_email'))       await adapter.exec("ALTER TABLE device_codes ADD COLUMN git_email TEXT");
  }

  if (!akHave.has('installation_id')) await adapter.exec("ALTER TABLE api_keys ADD COLUMN installation_id TEXT");
  if (!akHave.has('os_user'))         await adapter.exec("ALTER TABLE api_keys ADD COLUMN os_user TEXT");
  if (!akHave.has('git_name'))        await adapter.exec("ALTER TABLE api_keys ADD COLUMN git_name TEXT");
  if (!akHave.has('git_email'))       await adapter.exec("ALTER TABLE api_keys ADD COLUMN git_email TEXT");

  // flows.org_available — org-available flag.
  const flowCols = await adapter.all<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='flows'"
  );
  const flowHave = new Set(flowCols.map(c => c.column_name));
  if (!flowHave.has('org_available')) {
    await adapter.exec("ALTER TABLE flows ADD COLUMN org_available INTEGER NOT NULL DEFAULT 0");
    // One-time backfill: the flow currently set as org default is implicitly available.
    await adapter.exec("UPDATE flows SET org_available = 1 WHERE id IN (SELECT flow_id FROM flow_assignments WHERE scope = 'org')");
  }

  // flow_assignments multi-scope migration. PG can DROP / ADD CONSTRAINT in
  // place — simpler than the SQLite recreate dance.
  const faCols = await adapter.all<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='flow_assignments'",
  );
  const faHave = new Set(faCols.map(c => c.column_name));
  if (faCols.length > 0 && !faHave.has('target_id')) {
    await adapter.exec("ALTER TABLE flow_assignments ADD COLUMN target_id TEXT NOT NULL DEFAULT ''");
    await adapter.exec("ALTER TABLE flow_assignments DROP CONSTRAINT IF EXISTS flow_assignments_pkey");
    await adapter.exec("ALTER TABLE flow_assignments ADD PRIMARY KEY (org_id, scope, target_id)");
  }
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
  const state: PgState = { pool };
  const adapter = new PgAdapter(state);
  await bootstrap(adapter);
  return adapter;
}

/** Test-only entry point: spin up an in-process pg-mem instance. */
/**
 * Test-only: build an adapter over an arbitrary pool-shaped object, so the
 * transaction ROUTING can be asserted directly. Proving isolation through
 * pg-mem would not be faithful — it is one in-memory database with no
 * per-connection snapshot.
 */
export function __createPgAdapterForTest(pool: unknown): HubDb {
  return new PgAdapter({ pool: pool as Pool });
}

export async function openPgMemDb(): Promise<HubDb> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { newDb, DataType } = require('pg-mem') as typeof import('pg-mem');
  const memDb = newDb({ autoCreateForeignKeyIndices: true });
  registerPgMemPolyfills(memDb, DataType);
  const { Pool } = memDb.adapters.createPg();
  const pool = new Pool() as unknown as Pool;
  const state: PgState = { pool };
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
