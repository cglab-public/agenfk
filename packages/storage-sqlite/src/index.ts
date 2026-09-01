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
    this.database.prepare(
      'UPDATE items SET project_id = ?, type = ?, status = ?, parent_id = ?, data = ? WHERE id = ?'
    ).run(updated.projectId, updated.type, updated.status, updated.parentId ?? null, JSON.stringify(updated), id);
    return updated;
  }

  async deleteItem(id: string): Promise<boolean> {
    const result = this.database.prepare('DELETE FROM items WHERE id = ?').run(id) as { changes: number };
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
    sql += ' ORDER BY started_at ASC';
    if (query.limit !== undefined) { sql += ' LIMIT ?'; params.push(query.limit); }
    const rows = this.database.prepare(sql).all(...params) as any[];
    return rows.map((r) => this.mapAgentRunRow(r));
  }

  async appendRunEvent(event: RunEvent): Promise<void> {
    this.database.prepare(
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
      event.payload ?? null,
      event.tokens ?? null,
    );
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
