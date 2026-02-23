import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import {
  StorageProvider,
  PluginConfig,
  StorageQuery,
  AgenFKItem,
  Status,
  Project
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
    `);
  }

  private parseProject(data: string): Project {
    const p = JSON.parse(data);
    return { ...p, createdAt: new Date(p.createdAt), updatedAt: new Date(p.updatedAt) };
  }

  private parseItem(data: string): AgenFKItem {
    const item = JSON.parse(data);
    return {
      ...item,
      createdAt: new Date(item.createdAt),
      updatedAt: new Date(item.updatedAt),
      history: (item.history || []).map((h: any) => ({
        ...h,
        timestamp: new Date(h.timestamp),
      })),
    } as AgenFKItem;
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

  async createItem(item: AgenFKItem): Promise<AgenFKItem> {
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

  async updateItem(id: string, updates: Partial<AgenFKItem>): Promise<AgenFKItem> {
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

    const updated = { ...existing, ...updates, updatedAt: new Date() } as AgenFKItem;
    this.database.prepare(
      'UPDATE items SET project_id = ?, type = ?, status = ?, parent_id = ?, data = ? WHERE id = ?'
    ).run(updated.projectId, updated.type, updated.status, updated.parentId ?? null, JSON.stringify(updated), id);
    return updated;
  }

  async deleteItem(id: string): Promise<boolean> {
    const result = this.database.prepare('DELETE FROM items WHERE id = ?').run(id) as { changes: number };
    return result.changes > 0;
  }

  async getItem(id: string): Promise<AgenFKItem | null> {
    const row = this.database.prepare('SELECT data FROM items WHERE id = ?').get(id) as { data: string } | undefined;
    return row ? this.parseItem(row.data) : null;
  }

  async listItems(query?: StorageQuery): Promise<AgenFKItem[]> {
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

  async listChildren(parentId: string): Promise<AgenFKItem[]> {
    return this.listItems({ parentId });
  }
}
