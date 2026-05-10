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
    const result = this.database.prepare(
      "UPDATE hub_outbox SET payload = json_set(payload, '$.orgId', ?) WHERE json_extract(payload, '$.orgId') = ?"
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

  // ── Observability stubs ────────────────────────────────────────────────────
  // Real implementations land in the next task in the observability initiative.
  // The schema (token_events, ingestion_state, prs) is created above.

  async insertTokenEvent(_event: TokenEvent): Promise<void> {
    throw new Error('insertTokenEvent: not yet implemented');
  }

  async queryTokenEvents(_query: TokenEventQuery): Promise<TokenEvent[]> {
    throw new Error('queryTokenEvents: not yet implemented');
  }

  async getIngestionState(_sourcePath: string): Promise<IngestionState | null> {
    throw new Error('getIngestionState: not yet implemented');
  }

  async setIngestionState(_state: IngestionState): Promise<void> {
    throw new Error('setIngestionState: not yet implemented');
  }

  async insertPr(_pr: Pr): Promise<Pr> {
    throw new Error('insertPr: not yet implemented');
  }

  async updatePrSizing(
    _repo: string,
    _prNumber: number,
    _sizing: PrSizing,
    _shadow?: PrSizing,
  ): Promise<Pr> {
    throw new Error('updatePrSizing: not yet implemented');
  }

  async getPrByRepoNumber(_repo: string, _prNumber: number): Promise<Pr | null> {
    throw new Error('getPrByRepoNumber: not yet implemented');
  }

  async getPrsByItemId(_itemId: string): Promise<Pr[]> {
    throw new Error('getPrsByItemId: not yet implemented');
  }
}
