import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import {
  StorageProvider,
  PluginConfig,
  StorageQuery,
  AgEnFKItem,
  Status,
  Project,
  PauseSnapshot,
  Flow,
  TokenEvent,
  TokenEventQuery,
  IngestionState,
  AppSettings,
  DEFAULT_APP_SETTINGS,
  isLegalSettingValue,
  TerminalSession,
  Pr,
  PrSizing,
  AgentRun,
  RunEvent,
  AgentRunQuery,
} from '@agenfk/core';

// node:sqlite is a built-in module available from Node.js v22+.
// Using require() to avoid ESM/CJS interop issues in the compiled output.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

type DB = InstanceType<typeof DatabaseSync>;

export class SQLiteStorageProvider implements StorageProvider {
  name = 'sqlite-storage';
  version = '1.0.0';
  public dbPath: string = '';
  private db: DB | null = null;

  async init(config: PluginConfig): Promise<void> {
    this.dbPath = config.path || '.agenfk/db.sqlite';
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new DatabaseSync(this.dbPath);
    // WAL mode gives better read concurrency, but changes are written to the
    // WAL file rather than the main db file — so callers must NOT use
    // fs.watch() on the main file to detect writes (see server.ts).
    this.database.prepare('PRAGMA journal_mode = WAL').run();
    this.createTables();
  }

  async shutdown(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private get database(): DB {
    if (!this.db) throw new Error('[STORAGE] SQLite not initialized. Call init() first.');
    return this.db;
  }

  private createTables(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        parent_id TEXT,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_items_project ON items(project_id);
      CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);
      CREATE INDEX IF NOT EXISTS idx_items_parent ON items(parent_id);
      CREATE TABLE IF NOT EXISTS snapshots (
        id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_snapshots_item ON snapshots(item_id);
      CREATE TABLE IF NOT EXISTS flows (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS hub_outbox (
        event_id TEXT PRIMARY KEY,
        occurred_at TEXT NOT NULL,
        payload TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_hub_outbox_occurred ON hub_outbox(occurred_at);
      CREATE TABLE IF NOT EXISTS token_events (
        id TEXT PRIMARY KEY,
        ts TEXT NOT NULL,
        client TEXT NOT NULL,
        session_id TEXT NOT NULL,
        turn_id TEXT,
        model TEXT NOT NULL,
        input INTEGER NOT NULL DEFAULT 0,
        cached_input INTEGER NOT NULL DEFAULT 0,
        output INTEGER NOT NULL DEFAULT 0,
        reasoning INTEGER NOT NULL DEFAULT 0,
        total INTEGER NOT NULL DEFAULT 0,
        item_id TEXT,
        project_id TEXT,
        source_path TEXT NOT NULL,
        source_offset INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_token_events_ts ON token_events(ts);
      CREATE INDEX IF NOT EXISTS idx_token_events_item ON token_events(item_id);
      CREATE INDEX IF NOT EXISTS idx_token_events_session ON token_events(session_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_token_events_dedup
        ON token_events(client, source_path, source_offset);
      CREATE TABLE IF NOT EXISTS terminal_sessions (
        id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL,
        project_id TEXT,
        agent_id TEXT NOT NULL,
        agent_session_id TEXT,
        -- Part of the session IDENTITY, not decoration (BUG 63fcf702).
        --
        -- persist decides whether the terminal runs inside tmux, and
        -- auto_approve is baked into the tmux session NAME, so a restore that
        -- does not know them cannot find the session that survived: it looked
        -- for the ask variant of a session created as auto, found nothing, and
        -- started a second agent beside the one still running.
        persist INTEGER NOT NULL DEFAULT 0,
        auto_approve INTEGER NOT NULL DEFAULT 0,
        opened_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_terminal_sessions_item ON terminal_sessions(item_id);
      CREATE INDEX IF NOT EXISTS idx_terminal_sessions_project ON terminal_sessions(project_id);
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ingestion_state (
        source_path TEXT PRIMARY KEY,
        last_offset INTEGER NOT NULL,
        last_run_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS prs (
        id TEXT PRIMARY KEY,
        pr_number INTEGER NOT NULL,
        repo TEXT NOT NULL,
        item_id TEXT NOT NULL,
        opened_at TEXT NOT NULL,
        sizing_json TEXT NOT NULL,
        sizing_declared_at TEXT NOT NULL,
        sizing_shadow_json TEXT,
        last_sizing_check_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_prs_repo_number ON prs(repo, pr_number);
      CREATE INDEX IF NOT EXISTS idx_prs_item ON prs(item_id);
      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL,
        project_id TEXT,
        step TEXT NOT NULL,
        actor TEXT NOT NULL,
        harness TEXT NOT NULL,
        model TEXT NOT NULL,
        session_id TEXT,
        source_path TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        verdict TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_agent_runs_item ON agent_runs(item_id);
      CREATE INDEX IF NOT EXISTS idx_agent_runs_session ON agent_runs(session_id);
      CREATE TABLE IF NOT EXISTS run_events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        ts TEXT NOT NULL,
        lane TEXT NOT NULL,
        kind TEXT NOT NULL,
        tool TEXT,
        text TEXT,
        payload TEXT,
        tokens INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(run_id, seq);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_run_events_dedup ON run_events(run_id, seq);
    `);
    this.migrateFlowsTable();
    this.migrateTerminalSessionsTable();
  }

  // ── Hub outbox helpers ─────────────────────────────────────────────────────
  // Optional component: only used when an installation is configured to push to
  // a corp Hub. The local server appends events here and a flusher batches them
  // to the hub via HTTPS. Sync (better-sqlite3-style) for sub-millisecond
  // append on the request path.

  hubOutboxAppend(eventId: string, occurredAt: string, payloadJson: string): void {
    this.database.prepare(
      'INSERT OR IGNORE INTO hub_outbox (event_id, occurred_at, payload) VALUES (?, ?, ?)'
    ).run(eventId, occurredAt, payloadJson);
  }

  hubOutboxPeek(limit: number = 500): Array<{ event_id: string; occurred_at: string; payload: string; attempts: number; last_error: string | null }> {
    return this.database.prepare(
      'SELECT event_id, occurred_at, payload, attempts, last_error FROM hub_outbox ORDER BY occurred_at ASC LIMIT ?'
    ).all(limit) as any;
  }

  /**
   * The peek window of rows the flusher may actually POST under `orgId`'s
   * credentials (CGLAB-117). The org boundary lives in SQL, NOT in a JS filter
   * applied after the peek: with a post-peek filter, >=limit stale-org rows at
   * the head of the oldest-first window would starve every deliverable row
   * behind them forever — a silent stall replacing the silent loss this
   * exists to fix. One predicate, in one place, cannot drift.
   *
   * Deliverable = payload is valid JSON AND (orgId field absent or null — the
   * hub judges such rows and they carry no stamp to leak — OR orgId equals the
   * caller's org). The pending sentinel ('') can never match a real org;
   * orgId is required non-empty so no caller can aim at the sentinel.
   * Non-string orgIds (JSON numbers/objects) never equal a text orgId in
   * SQLite. Unparseable payloads are excluded: they can never deliver and
   * would throw for the WHOLE batch on the way into the POST.
   */
  hubOutboxPeekDeliverable(limit: number, orgId: string): Array<{ event_id: string; occurred_at: string; payload: string; attempts: number; last_error: string | null }> {
    if (typeof orgId !== 'string' || orgId.length === 0) {
      throw new Error('hubOutboxPeekDeliverable: orgId must be a non-empty string');
    }
    return this.database.prepare(
      `SELECT event_id, occurred_at, payload, attempts, last_error
         FROM hub_outbox
        WHERE json_valid(payload) = 1
          AND (json_extract(payload, '$.orgId') IS NULL OR json_extract(payload, '$.orgId') = ?)
        ORDER BY occurred_at ASC LIMIT ?`
    ).all(orgId, limit) as any;
  }

  hubOutboxDelete(eventIds: string[]): void {
    if (eventIds.length === 0) return;
    const placeholders = eventIds.map(() => '?').join(',');
    this.database.prepare(`DELETE FROM hub_outbox WHERE event_id IN (${placeholders})`).run(...eventIds);
  }

  hubOutboxIncrementAttempt(eventIds: string[], lastError: string | null): void {
    if (eventIds.length === 0) return;
    const stmt = this.database.prepare(
      'UPDATE hub_outbox SET attempts = attempts + 1, last_error = ? WHERE event_id = ?'
    );
    for (const id of eventIds) stmt.run(lastError, id);
  }

  hubOutboxCount(): number {
    const row = this.database.prepare('SELECT COUNT(*) AS c FROM hub_outbox').get() as { c: number };
    return row.c;
  }

  /**
   * Outbox row counts keyed by the orgId embedded in each payload (CGLAB-117).
   * Lets `hub status`/`join`/`login` surface rows left stamped with a stale org
   * after a re-onboard — those rows are never deliverable under current
   * credentials and wait for an explicit carry-over or discard.
   *
   * The PENDING_ORG sentinel ('') is included: it is the count of rows awaiting
   * their stamp, a different condition, and callers interpret it as such.
   * Rows whose payload is not valid JSON are EXCLUDED — sqlite's json_extract
   * throws on malformed input, so they are filtered with json_valid; such rows
   * can never deliver and are invisible to this count.
   */
  hubOutboxOrgCounts(): Record<string, number> {
    const rows = this.database.prepare(
      "SELECT json_extract(payload, '$.orgId') AS org, COUNT(*) AS c FROM hub_outbox WHERE json_valid(payload) = 1 GROUP BY org"
    ).all() as Array<{ org: string | null; c: number }>;
    const out: Record<string, number> = {};
    for (const r of rows) {
      if (typeof r.org !== 'string') continue; // valid JSON without an orgId field
      out[r.org] = Number(r.c);
    }
    return out;
  }

  /**
   * Per-org outbox summaries (CGLAB-117 story 3): count, occurred-at range and
   * event-type tallies, keyed by the embedded orgId. Powers the
   * `agenfk hub carry-over` confirmation summary via /internal/hub/status — a
   * stamp-rewrite is the one operation on the outbox that must never be
   * executed blind. Rows with unparseable payloads or no orgId field carry no
   * org to summarize and are excluded (same rule as hubOutboxOrgCounts).
   */
  hubOutboxOrgSummaries(): Record<string, { count: number; firstOccurredAt: string; lastOccurredAt: string; types: Record<string, number> }> {
    // One scan, aggregated per (org, type); org-level count/range fold up in
    // JS. /internal/hub/status calls this on every CLI invocation (preAction
    // banner), so a second full GROUP BY here would double the request cost.
    const rows = this.database.prepare(
      "SELECT json_extract(payload, '$.orgId') AS org, json_extract(payload, '$.type') AS t, COUNT(*) AS c, MIN(occurred_at) AS f, MAX(occurred_at) AS l FROM hub_outbox WHERE json_valid(payload) = 1 GROUP BY org, t"
    ).all() as Array<{ org: string | null; t: string | null; c: number; f: string; l: string }>;
    const out: Record<string, { count: number; firstOccurredAt: string; lastOccurredAt: string; types: Record<string, number> }> = {};
    for (const r of rows) {
      if (typeof r.org !== 'string') continue;
      const g = out[r.org] ??= { count: 0, firstOccurredAt: r.f, lastOccurredAt: r.l, types: {} };
      g.count += Number(r.c);
      if (typeof r.f === 'string' && r.f < g.firstOccurredAt) g.firstOccurredAt = r.f;
      if (typeof r.l === 'string' && r.l > g.lastOccurredAt) g.lastOccurredAt = r.l;
      if (typeof r.t === 'string') g.types[r.t] = Number(r.c);
    }
    return out;
  }

  /**
   * Rewrite the embedded `orgId` in queued outbox payloads from `from` to
   * `to`. Used by `agenfk hub repoint` after the hub admin renames the org —
   * without this, queued events keep the stale orgId and get rejected by the
   * renamed hub. Uses sqlite's json1 functions so we don't have to round-trip
   * each payload through JS.
   * Returns the number of rows updated.
   */
  hubOutboxRewriteOrgId(from: string, to: string): number {
    if (typeof to !== 'string' || to.length === 0) {
      throw new Error('hubOutboxRewriteOrgId: target orgId must be a non-empty string');
    }
    if (from === to) return 0;
    // json_valid guard: json_extract RAISES on a malformed payload (see the
    // note in hubOutboxOrgCounts), so without it one corrupt row would abort
    // the whole UPDATE with "malformed JSON". Such rows are acknowledged to
    // exist — the flusher skips them and cap-pruning drops them.
    const result = this.database.prepare(
      "UPDATE hub_outbox SET payload = json_set(payload, '$.orgId', ?) WHERE json_valid(payload) = 1 AND json_extract(payload, '$.orgId') = ?"
    ).run(to, from);
    return Number(result.changes ?? 0);
  }

  /**
   * Add `persist` / `auto_approve` to `terminal_sessions` when an older
   * database lacks them (BUG 63fcf702).
   *
   * Plain ALTER with a default rather than a rebuild: both are new columns
   * with a safe zero value, and rows written before this existed genuinely do
   * not know their session's identity — defaulting them to "not persisted,
   * prompts on" is the conservative answer, not a guess dressed up as data.
   */
  private migrateTerminalSessionsTable(): void {
    const columns = (
      this.database.prepare('PRAGMA table_info(terminal_sessions)').all() as { name: string }[]
    ).map((c) => c.name);
    if (!columns.includes('persist')) {
      this.database.exec('ALTER TABLE terminal_sessions ADD COLUMN persist INTEGER NOT NULL DEFAULT 0');
    }
    if (!columns.includes('auto_approve')) {
      this.database.exec('ALTER TABLE terminal_sessions ADD COLUMN auto_approve INTEGER NOT NULL DEFAULT 0');
    }
  }

  /** Remove stale `project_id` column from `flows` if present (recreate via rename). */
  private migrateFlowsTable(): void {
    const columns = (
      this.database.prepare('PRAGMA table_info(flows)').all() as { name: string }[]
    ).map((c) => c.name);

    if (!columns.includes('project_id')) return;

    this.database.exec(`
      BEGIN;
      CREATE TABLE flows_new (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      INSERT INTO flows_new (id, data) SELECT id, data FROM flows;
      DROP TABLE flows;
      ALTER TABLE flows_new RENAME TO flows;
      COMMIT;
    `);
  }

  private parseProject(data: string): Project {
    const p = JSON.parse(data);
    return { ...p, createdAt: new Date(p.createdAt), updatedAt: new Date(p.updatedAt) };
  }

  private parseItem(data: string): AgEnFKItem {
    const item = JSON.parse(data);
    return {
      ...item,
      createdAt: new Date(item.createdAt),
      updatedAt: new Date(item.updatedAt),
      history: (item.history || []).map((h: any) => ({
        ...h,
        timestamp: new Date(h.timestamp),
      })),
    } as AgEnFKItem;
  }

  // ── Project methods ──────────────────────────────────────────────────────

  async createProject(project: Project): Promise<Project> {
    this.database.prepare('INSERT INTO projects (id, data) VALUES (?, ?)').run(
      project.id, JSON.stringify(project)
    );
    return project;
  }

  async updateProject(id: string, updates: Partial<Project>): Promise<Project> {
    const existing = await this.getProject(id);
    if (!existing) throw new Error(`Project ${id} not found`);
    const updated = { ...existing, ...updates, updatedAt: new Date() };
    this.database.prepare('UPDATE projects SET data = ? WHERE id = ?').run(
      JSON.stringify(updated), id
    );
    return updated;
  }

  async deleteProject(id: string): Promise<boolean> {
    const result = this.database.prepare('DELETE FROM projects WHERE id = ?').run(id) as { changes: number };
    this.database.prepare('DELETE FROM items WHERE project_id = ?').run(id);
    return result.changes > 0;
  }

  async getProject(id: string): Promise<Project | null> {
    const row = this.database.prepare('SELECT data FROM projects WHERE id = ?').get(id) as { data: string } | undefined;
    return row ? this.parseProject(row.data) : null;
  }

  async listProjects(): Promise<Project[]> {
    const rows = this.database.prepare('SELECT data FROM projects').all() as { data: string }[];
    return rows.map(r => this.parseProject(r.data));
  }

  // ── Item methods ─────────────────────────────────────────────────────────

  async createItem(item: AgEnFKItem): Promise<AgEnFKItem> {
    if (!item.history) item.history = [];
    item.history.push({
      id: uuidv4(),
      fromStatus: 'TODO' as Status,
      toStatus: item.status,
      timestamp: new Date(),
    });
    this.database.prepare(
      'INSERT INTO items (id, project_id, type, status, parent_id, data) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(item.id, item.projectId, item.type, item.status, item.parentId ?? null, JSON.stringify(item));
    return item;
  }

  async updateItem(id: string, updates: Partial<AgEnFKItem>): Promise<AgEnFKItem> {
    const existing = await this.getItem(id);
    if (!existing) throw new Error(`Item ${id} not found`);

    if (updates.status !== undefined && updates.status !== existing.status) {
      const history = existing.history || [];
      history.push({
        id: uuidv4(),
        fromStatus: existing.status,
        toStatus: updates.status,
        timestamp: new Date(),
      });
      updates.history = history;
    }

    const updated = { ...existing, ...updates, updatedAt: new Date() } as AgEnFKItem;
    /*
     * A card that reached DONE has no failed-attempt history to carry
     * (CGLAB-202). Reaching the end is the one event that means the work
     * landed, so it is the one that clears - a run ending `done` does not,
     * because the hook closes runs `done` on SessionEnd whether or not the
     * attempt succeeded.
     *
     * Cleared HERE because every path to DONE routes through this method:
     * validate_progress, its sibling propagation, and an internal PUT.
     */
    if (updated.status === Status.DONE && existing.status !== Status.DONE) {
      updated.failureCount = 0;
    }
    this.database.prepare(
      'UPDATE items SET project_id = ?, type = ?, status = ?, parent_id = ?, data = ? WHERE id = ?'
    ).run(updated.projectId, updated.type, updated.status, updated.parentId ?? null, JSON.stringify(updated), id);
    return updated;
  }

  async deleteItem(id: string): Promise<boolean> {
    const result = this.database.prepare('DELETE FROM items WHERE id = ?').run(id) as { changes: number };
    // The card's remembered terminals go with it. Left behind, they would make
    // the desktop try to resolve a worktree for a card that no longer exists —
    // at app startup, which is the least helpful moment for it to fail, and on
    // every launch from then on.
    this.database.prepare('DELETE FROM terminal_sessions WHERE item_id = ?').run(id);
    return result.changes > 0;
  }

  async getItem(id: string): Promise<AgEnFKItem | null> {
    const row = this.database.prepare('SELECT data FROM items WHERE id = ?').get(id) as { data: string } | undefined;
    return row ? this.parseItem(row.data) : null;
  }

  async listItems(query?: StorageQuery): Promise<AgEnFKItem[]> {
    let sql = 'SELECT data FROM items WHERE 1=1';
    const params: (string | number)[] = [];

    if (query?.projectId) { sql += ' AND project_id = ?'; params.push(query.projectId); }
    if (query?.type)      { sql += ' AND type = ?';       params.push(query.type); }
    if (query?.status)    { sql += ' AND status = ?';     params.push(query.status); }
    if (query?.parentId)  { sql += ' AND parent_id = ?';  params.push(query.parentId); }

    if (query?.limit !== undefined || query?.offset !== undefined) {
      sql += ' LIMIT ? OFFSET ?';
      params.push(query.limit ?? -1, query.offset ?? 0);
    }

    const rows = this.database.prepare(sql).all(...params) as { data: string }[];
    return rows.map(r => this.parseItem(r.data));
  }

  async listChildren(parentId: string): Promise<AgEnFKItem[]> {
    return this.listItems({ parentId });
  }

  // ── Snapshot methods (pause/resume) ─────────────────────────────────────

  private parseSnapshot(data: string): PauseSnapshot {
    const s = JSON.parse(data);
    return {
      ...s,
      pausedAt: new Date(s.pausedAt),
      resumedAt: s.resumedAt ? new Date(s.resumedAt) : undefined,
    };
  }

  async createSnapshot(snapshot: PauseSnapshot): Promise<PauseSnapshot> {
    // Replace any existing active snapshot for the same item
    this.database.prepare('DELETE FROM snapshots WHERE item_id = ?').run(snapshot.itemId);
    this.database.prepare(
      'INSERT INTO snapshots (id, item_id, project_id, data) VALUES (?, ?, ?, ?)'
    ).run(snapshot.id, snapshot.itemId, snapshot.projectId, JSON.stringify(snapshot));
    return snapshot;
  }

  async getSnapshot(id: string): Promise<PauseSnapshot | null> {
    const row = this.database.prepare('SELECT data FROM snapshots WHERE id = ?').get(id) as { data: string } | undefined;
    return row ? this.parseSnapshot(row.data) : null;
  }

  async getSnapshotByItemId(itemId: string): Promise<PauseSnapshot | null> {
    const row = this.database.prepare('SELECT data FROM snapshots WHERE item_id = ? ORDER BY rowid DESC LIMIT 1').get(itemId) as { data: string } | undefined;
    return row ? this.parseSnapshot(row.data) : null;
  }

  async deleteSnapshot(id: string): Promise<boolean> {
    const result = this.database.prepare('DELETE FROM snapshots WHERE id = ?').run(id) as { changes: number };
    return result.changes > 0;
  }

  // ── Flow methods ─────────────────────────────────────────────────────────

  private parseFlow(data: string): Flow {
    const f = JSON.parse(data);
    return {
      ...f,
      createdAt: new Date(f.createdAt),
      updatedAt: new Date(f.updatedAt),
    };
  }

  async createFlow(flow: Flow): Promise<Flow> {
    this.database.prepare(
      'INSERT INTO flows (id, data) VALUES (?, ?)'
    ).run(flow.id, JSON.stringify(flow));
    return flow;
  }

  async updateFlow(id: string, updates: Partial<Flow>): Promise<Flow> {
    const existing = await this.getFlow(id);
    if (!existing) throw new Error(`Flow ${id} not found`);
    const updated = { ...existing, ...updates, updatedAt: new Date() };
    this.database.prepare('UPDATE flows SET data = ? WHERE id = ?').run(
      JSON.stringify(updated), id
    );
    return updated;
  }

  async deleteFlow(id: string): Promise<boolean> {
    const result = this.database.prepare('DELETE FROM flows WHERE id = ?').run(id) as { changes: number };
    return result.changes > 0;
  }

  async getFlow(id: string): Promise<Flow | null> {
    const row = this.database.prepare('SELECT data FROM flows WHERE id = ?').get(id) as { data: string } | undefined;
    return row ? this.parseFlow(row.data) : null;
  }

  async listFlows(): Promise<Flow[]> {
    const rows = this.database.prepare('SELECT data FROM flows').all() as { data: string }[];
    return rows.map(r => this.parseFlow(r.data));
  }

  // ── Observability: token events ─────────────────────────────────────────────

  async insertTokenEvent(event: TokenEvent): Promise<void> {
    this.database.prepare(
      `INSERT INTO token_events
        (id, ts, client, session_id, turn_id, model,
         input, cached_input, output, reasoning, total,
         item_id, project_id, source_path, source_offset)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      event.id,
      event.ts,
      event.client,
      event.sessionId,
      event.turnId ?? null,
      event.model,
      event.input,
      event.cachedInput,
      event.output,
      event.reasoning,
      event.total,
      event.itemId ?? null,
      event.projectId ?? null,
      event.sourcePath,
      event.sourceOffset,
    );
  }

  async queryTokenEvents(query: TokenEventQuery): Promise<TokenEvent[]> {
    const where: string[] = [];
    const params: any[] = [];
    if (query.itemId !== undefined) { where.push('item_id = ?'); params.push(query.itemId); }
    if (query.projectId !== undefined) { where.push('project_id = ?'); params.push(query.projectId); }
    if (query.client !== undefined) { where.push('client = ?'); params.push(query.client); }
    if (query.since !== undefined) { where.push('ts >= ?'); params.push(query.since); }
    if (query.until !== undefined) { where.push('ts < ?'); params.push(query.until); }
    let sql =
      `SELECT id, ts, client, session_id, turn_id, model,
              input, cached_input, output, reasoning, total,
              item_id, project_id, source_path, source_offset
         FROM token_events`;
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY ts ASC';
    if (query.limit !== undefined) { sql += ' LIMIT ?'; params.push(query.limit); }
    const rows = this.database.prepare(sql).all(...params) as any[];
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      client: r.client,
      sessionId: r.session_id,
      turnId: r.turn_id ?? undefined,
      model: r.model,
      input: r.input,
      cachedInput: r.cached_input,
      output: r.output,
      reasoning: r.reasoning,
      total: r.total,
      itemId: r.item_id ?? undefined,
      projectId: r.project_id ?? undefined,
      sourcePath: r.source_path,
      sourceOffset: r.source_offset,
    }));
  }

  // ── Observability: agent runs + transcript events ──────────────────────────

  private mapAgentRunRow(r: any): AgentRun {
    return {
      id: r.id,
      itemId: r.item_id,
      projectId: r.project_id ?? undefined,
      step: r.step,
      actor: r.actor,
      harness: r.harness,
      model: r.model,
      sessionId: r.session_id ?? undefined,
      sourcePath: r.source_path ?? undefined,
      status: r.status,
      verdict: r.verdict ?? undefined,
      startedAt: r.started_at,
      endedAt: r.ended_at ?? undefined,
    };
  }

  async createAgentRun(run: AgentRun): Promise<AgentRun> {
    this.database.prepare(
      `INSERT INTO agent_runs
        (id, item_id, project_id, step, actor, harness, model,
         session_id, source_path, status, verdict, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      run.id,
      run.itemId,
      run.projectId ?? null,
      run.step,
      run.actor,
      run.harness,
      run.model,
      run.sessionId ?? null,
      run.sourcePath ?? null,
      run.status,
      run.verdict ?? null,
      run.startedAt,
      run.endedAt ?? null,
    );
    return run;
  }

  async updateAgentRun(id: string, updates: Partial<AgentRun>): Promise<AgentRun> {
    const existing = await this.getAgentRun(id);
    if (!existing) throw new Error(`Agent run not found: ${id}`);
    const merged = { ...existing, ...updates };
    this.database.prepare(
      `UPDATE agent_runs SET
         item_id = ?, project_id = ?, step = ?, actor = ?, harness = ?, model = ?,
         session_id = ?, source_path = ?, status = ?, verdict = ?, started_at = ?, ended_at = ?
       WHERE id = ?`
    ).run(
      merged.itemId,
      merged.projectId ?? null,
      merged.step,
      merged.actor,
      merged.harness,
      merged.model,
      merged.sessionId ?? null,
      merged.sourcePath ?? null,
      merged.status,
      merged.verdict ?? null,
      merged.startedAt,
      merged.endedAt ?? null,
      id,
    );
    return merged;
  }

  async getAgentRun(id: string): Promise<AgentRun | null> {
    const row = this.database.prepare('SELECT * FROM agent_runs WHERE id = ?').get(id) as any;
    return row ? this.mapAgentRunRow(row) : null;
  }

  async getAgentRunBySession(sessionId: string): Promise<AgentRun | null> {
    const row = this.database.prepare(
      'SELECT * FROM agent_runs WHERE session_id = ? ORDER BY started_at DESC LIMIT 1'
    ).get(sessionId) as any;
    return row ? this.mapAgentRunRow(row) : null;
  }

  async listAgentRuns(query: AgentRunQuery): Promise<AgentRun[]> {
    const where: string[] = [];
    const params: any[] = [];
    if (query.itemId !== undefined) { where.push('item_id = ?'); params.push(query.itemId); }
    if (query.projectId !== undefined) { where.push('project_id = ?'); params.push(query.projectId); }
    if (query.status !== undefined) { where.push('status = ?'); params.push(query.status); }
    let sql = 'SELECT * FROM agent_runs';
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    /*
     * Newest first, because the LIMIT applies AFTER the sort.
     *
     * Ordered ASC, a capped response was the OLDEST runs ever recorded — so on
     * a machine with more history than the page size, an agent started right
     * now was never in the answer, and the sessions rail showed work that
     * finished weeks ago instead. Runs also stay `running` forever (nothing
     * sends the closing update), so those old rows never aged out of the
     * filter on their own.
     */
    // rowid breaks ties. started_at has millisecond resolution, so a burst of
    // runs recorded in the same millisecond would otherwise come back in an
    // arbitrary order — and with a LIMIT applied, an arbitrary SUBSET.
    sql += ' ORDER BY started_at DESC, rowid DESC';
    if (query.limit !== undefined) { sql += ' LIMIT ?'; params.push(query.limit); }
    const rows = this.database.prepare(sql).all(...params) as any[];
    // Oldest-first for the caller: the page is chosen from the newest end, but
    // consumers that render a sequence still want it in the order it happened.
    return rows.map((r) => this.mapAgentRunRow(r)).reverse();
  }

  /**
   * Append an event and report WHERE it landed.
   *
   * Returning the position is not bookkeeping. The number is assigned inside
   * the insert — correctly, because computing it in the route raced — but that
   * left the caller holding an object whose `seq` is still undefined, which is
   * the object the server then emits over the socket. Every live consumer
   * compares events by `seq`, so a stream of undefineds collapses to one
   * event: a Claude Code session showed a single line in the Runs panel and
   * then nothing, for as long as it ran.
   *
   * Null means nothing was written. The insert is `INSERT OR IGNORE` against
   * `UNIQUE(run_id, seq)`, so a repeat is silently dropped — and reporting a
   * position for a row that does not exist would have the caller broadcast a
   * duplicate to every open panel.
   */
  async appendRunEvent(event: RunEvent): Promise<number | null> {
    /*
     * The position is assigned INSIDE the insert when the caller did not give
     * one, and that is the whole fix.
     *
     * It used to be computed in the route as `(await listRunEvents(id)).length`
     * — a read, an await, then a write. Two events in flight computed the SAME
     * number, and the insert is `INSERT OR IGNORE` against
     * `UNIQUE(run_id, seq)`, so the second was dropped SILENTLY: the API
     * answered 201 and emitted run:event, and the UI showed an event that
     * vanished on the next refresh.
     *
     * It survived because the pi tailer is a serialized loop that never
     * produced two at once. The Claude Code hook makes concurrency ordinary.
     *
     * Zero-based, matching what `.length` produced before, so existing rows
     * and existing readers are unaffected.
     *
     * A SELECT-based insert is atomic within the statement, so no two writers
     * can read the same maximum. It also replaces an O(n) read of every event
     * on the run with a single indexed aggregate.
     */
    if (event.seq === undefined || event.seq === null) {
      const written = this.database.prepare(
        `INSERT OR IGNORE INTO run_events
          (id, run_id, seq, ts, lane, kind, tool, text, payload, tokens)
         SELECT ?, ?, COALESCE(MAX(seq) + 1, 0), ?, ?, ?, ?, ?, ?, ?
           FROM run_events WHERE run_id = ?`
      ).run(
        event.id,
        event.runId,
        event.ts,
        event.lane,
        event.kind,
        event.tool ?? null,
        event.text ?? null,
        // Already a string by the time it reaches storage: the route
        // serialises it. Stringifying again double-encoded it, so a reader
        // doing JSON.parse got back a string instead of the object.
        event.payload ?? null,
        event.tokens ?? null,
        event.runId,
      );
      /*
       * Read back by ID, not by recomputing the maximum. Another writer may
       * have appended in between, and `MAX(seq)` would then report their
       * position as ours. The id is the only thing that identifies this row.
       */
      if (written.changes === 0) return null;
      const row = this.database
        .prepare('SELECT seq FROM run_events WHERE id = ?')
        .get(event.id) as { seq: number } | undefined;
      return row?.seq ?? null;
    }

    // An explicit position wins. The pi tailer knows the real order from the
    // transcript, and that order is better than arrival order.
    const explicit = this.database.prepare(
      `INSERT OR IGNORE INTO run_events
        (id, run_id, seq, ts, lane, kind, tool, text, payload, tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      event.id,
      event.runId,
      event.seq,
      event.ts,
      event.lane,
      event.kind,
      event.tool ?? null,
      event.text ?? null,
      // Passed through, exactly as the auto-position branch does. It is
      // already a string - the route serialises it - and stringifying again
      // stored a string OF a string, so a reader doing JSON.parse got the
      // text back instead of the object. The two branches disagreed about
      // the same field, and this is the one the pi tailer always took.
      event.payload ?? null,
      event.tokens ?? null,
    );
    // The position asked for, or nothing when the row was already there.
    return explicit.changes === 0 ? null : event.seq;
  }


  async listRunEvents(runId: string): Promise<RunEvent[]> {
    const rows = this.database.prepare(
      'SELECT * FROM run_events WHERE run_id = ? ORDER BY seq ASC'
    ).all(runId) as any[];
    return rows.map((r) => ({
      id: r.id,
      runId: r.run_id,
      seq: r.seq,
      ts: r.ts,
      lane: r.lane,
      kind: r.kind,
      tool: r.tool ?? undefined,
      text: r.text ?? undefined,
      payload: r.payload ?? undefined,
      tokens: r.tokens ?? undefined,
    }));
  }

  // ── Observability: ingestion state (resumable file-watcher offsets) ────────

  /**
   * Installation-wide settings, as stored values layered over the defaults.
   *
   * Key/value rather than one column per setting: a new setting then needs no
   * migration, and a row written by a NEWER version that this one does not know
   * about is ignored on read instead of crashing — which matters because the
   * desktop app, the CLI and the server can be different builds against the
   * same database.
   *
   * Values are JSON so a boolean stays a boolean. Storing '1'/'0' or 'true' as
   * bare text is how a preference comes back as a truthy string and inverts
   * itself.
   */
  async listTerminalSessions(projectId?: string): Promise<TerminalSession[]> {
    const rows = (projectId
      ? this.database.prepare(
          'SELECT * FROM terminal_sessions WHERE project_id = ? ORDER BY opened_at'
        ).all(projectId)
      : this.database.prepare('SELECT * FROM terminal_sessions ORDER BY opened_at').all()
    ) as Array<Record<string, string | null>>;
    return rows.map(r => ({
      id: r.id as string,
      itemId: r.item_id as string,
      projectId: r.project_id ?? undefined,
      agentId: r.agent_id as string,
      // null and undefined both mean "cannot resume this one"; normalised here
      // so no caller has to know which of the two it got back.
      agentSessionId: r.agent_session_id ?? undefined,
      // SQLite has no boolean. Compared against 1 rather than coerced, so the
      // string "0" a legacy row might hold cannot come back as true.
      persist: Number(r.persist) === 1,
      autoApprove: Number(r.auto_approve) === 1,
      openedAt: r.opened_at as string,
    }));
  }

  async recordTerminalSession(session: TerminalSession): Promise<TerminalSession> {
    this.database.prepare(
      'INSERT INTO terminal_sessions ' +
      '(id, item_id, project_id, agent_id, agent_session_id, persist, auto_approve, opened_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      session.id, session.itemId, session.projectId ?? null,
      session.agentId, session.agentSessionId ?? null,
      session.persist ? 1 : 0, session.autoApprove ? 1 : 0,
      session.openedAt,
    );
    return session;
  }

  async forgetTerminalSession(id: string): Promise<void> {
    this.database.prepare('DELETE FROM terminal_sessions WHERE id = ?').run(id);
  }

  async getSettings(): Promise<AppSettings> {
    const rows = this.database.prepare('SELECT key, value FROM app_settings')
      .all() as Array<{ key: string; value: string }>;
    // Object.create(null), not {}: a row keyed '__proto__' would otherwise set
    // the prototype instead of an own property, and the later lookups would
    // resolve THROUGH it — turning a stored row into a way to flip settings
    // this function claims to ignore. Needs direct database access to exploit,
    // but the claim in the comment above should be true, not nearly true.
    const stored: Record<string, unknown> = Object.create(null);
    for (const row of rows) {
      // A corrupt row must not take the whole settings read down with it; the
      // default is a safe answer and the user can set it again.
      try { stored[row.key] = JSON.parse(row.value); } catch { /* keep the default */ }
    }
    const settings = { ...DEFAULT_APP_SETTINGS };
    // Only keys the CURRENT build knows. Anything else in the table belongs to
    // another version and is none of this one's business.
    for (const key of Object.keys(DEFAULT_APP_SETTINGS) as Array<keyof AppSettings>) {
      const value = stored[key];
      // `isLegalSettingValue`, not a `typeof` comparison. They agree for every
      // boolean; they part company on an enum, where `typeof` accepts any
      // string at all. A row saying soundTiming is 'whenever' — written by an
      // older build, a newer one, or a hand-edited database — would otherwise
      // come back out and behave as whichever branch the UI falls through to.
      if (isLegalSettingValue(key, value)) {
        (settings[key] as unknown) = value;
      }
    }
    return settings;
  }

  async updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    const write = this.database.prepare(
      'INSERT INTO app_settings (key, value) VALUES (?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    );
    // A transaction so a multi-key write cannot land half-applied and leave the
    // user with a settings screen showing a state they never chose. Written as
    // explicit BEGIN/COMMIT because the driver here is node:sqlite's
    // DatabaseSync, which has no better-sqlite3-style transaction() wrapper.
    this.database.exec('BEGIN');
    try {
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        write.run(key, JSON.stringify(value));
      }
      this.database.exec('COMMIT');
    } catch (err) {
      this.database.exec('ROLLBACK');
      throw err;
    }
    return this.getSettings();
  }

  async getIngestionState(sourcePath: string): Promise<IngestionState | null> {
    const row = this.database.prepare(
      'SELECT source_path, last_offset, last_run_at FROM ingestion_state WHERE source_path = ?'
    ).get(sourcePath) as { source_path: string; last_offset: number; last_run_at: string } | undefined;
    if (!row) return null;
    return {
      sourcePath: row.source_path,
      lastOffset: row.last_offset,
      lastRunAt: row.last_run_at,
    };
  }

  async setIngestionState(state: IngestionState): Promise<void> {
    this.database.prepare(
      `INSERT INTO ingestion_state (source_path, last_offset, last_run_at)
       VALUES (?, ?, ?)
       ON CONFLICT(source_path) DO UPDATE SET
         last_offset = excluded.last_offset,
         last_run_at = excluded.last_run_at`
    ).run(state.sourcePath, state.lastOffset, state.lastRunAt);
  }

  // ── Observability: PR registration ─────────────────────────────────────────

  private rowToPr(row: any): Pr {
    return {
      id: row.id,
      prNumber: row.pr_number,
      repo: row.repo,
      itemId: row.item_id,
      openedAt: row.opened_at,
      sizing: JSON.parse(row.sizing_json) as PrSizing,
      sizingDeclaredAt: row.sizing_declared_at,
      sizingShadow: row.sizing_shadow_json ? (JSON.parse(row.sizing_shadow_json) as PrSizing) : undefined,
      lastSizingCheckAt: row.last_sizing_check_at ?? undefined,
    };
  }

  async insertPr(pr: Pr): Promise<Pr> {
    // Idempotent on (repo, pr_number): if row exists, refresh sizing fields
    // (and itemId/openedAt) instead of throwing on the unique index.
    this.database.prepare(
      `INSERT INTO prs
         (id, pr_number, repo, item_id, opened_at,
          sizing_json, sizing_declared_at, sizing_shadow_json, last_sizing_check_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo, pr_number) DO UPDATE SET
         item_id = excluded.item_id,
         opened_at = excluded.opened_at,
         sizing_json = excluded.sizing_json,
         sizing_declared_at = excluded.sizing_declared_at,
         sizing_shadow_json = excluded.sizing_shadow_json,
         last_sizing_check_at = excluded.last_sizing_check_at`
    ).run(
      pr.id,
      pr.prNumber,
      pr.repo,
      pr.itemId,
      pr.openedAt,
      JSON.stringify(pr.sizing),
      pr.sizingDeclaredAt,
      pr.sizingShadow ? JSON.stringify(pr.sizingShadow) : null,
      pr.lastSizingCheckAt ?? null,
    );
    const row = this.database.prepare(
      'SELECT * FROM prs WHERE repo = ? AND pr_number = ?'
    ).get(pr.repo, pr.prNumber) as any;
    return this.rowToPr(row);
  }

  async updatePrSizing(
    repo: string,
    prNumber: number,
    sizing: PrSizing,
    shadow?: PrSizing,
  ): Promise<Pr> {
    const now = new Date().toISOString();
    const result = this.database.prepare(
      `UPDATE prs SET
         sizing_json = ?,
         sizing_declared_at = ?,
         sizing_shadow_json = ?,
         last_sizing_check_at = ?
       WHERE repo = ? AND pr_number = ?`
    ).run(
      JSON.stringify(sizing),
      now,
      shadow ? JSON.stringify(shadow) : null,
      now,
      repo,
      prNumber,
    );
    if (Number(result.changes ?? 0) === 0) {
      throw new Error(`updatePrSizing: PR ${repo}#${prNumber} not found`);
    }
    const row = this.database.prepare(
      'SELECT * FROM prs WHERE repo = ? AND pr_number = ?'
    ).get(repo, prNumber) as any;
    return this.rowToPr(row);
  }

  async getPrByRepoNumber(repo: string, prNumber: number): Promise<Pr | null> {
    const row = this.database.prepare(
      'SELECT * FROM prs WHERE repo = ? AND pr_number = ?'
    ).get(repo, prNumber) as any;
    return row ? this.rowToPr(row) : null;
  }

  async getPrsByItemId(itemId: string): Promise<Pr[]> {
    const rows = this.database.prepare(
      'SELECT * FROM prs WHERE item_id = ? ORDER BY opened_at ASC'
    ).all(itemId) as any[];
    return rows.map((r) => this.rowToPr(r));
  }
}
