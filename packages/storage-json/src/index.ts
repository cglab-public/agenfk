import { v4 as uuidv4 } from "uuid";
import * as fs from 'fs';
import * as path from 'path';
import {
  StorageProvider,
  PluginConfig,
  StorageQuery,
  AgenFKItem,
  Status,
  ItemType,
  BaseItem,
  TokenUsage,
  ContextItem,
  Project,
  PauseSnapshot
} from "@agenfk/core";

interface JSONData {
  projects: Project[];
  items: AgenFKItem[];
  snapshots: PauseSnapshot[];
}

export class JSONStorageProvider implements StorageProvider {
  name = "json-storage";
  version = "1.0.0";
  public dbPath: string = "";
  private data: JSONData = { projects: [], items: [], snapshots: [] };
  private lock: Promise<any> = Promise.resolve();

  async init(config: PluginConfig): Promise<void> {
    this.dbPath = config.path || ".agenfk/db.json";
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Reset data to ensure clean state if re-initialized with a different path (e.g. in tests)
    this.data = { projects: [], items: [], snapshots: [] };

    return this.runLocked(() => {
      this.load();
    });
  }

  private runLocked<T>(fn: () => T | Promise<T>): Promise<T> {
    const operation = this.lock.then(async () => {
      try {
        return await fn();
      } catch (e) {
        throw e;
      }
    });
    this.lock = operation.catch(() => {}); // Prevent chain break on error
    return operation;
  }

  private load() {
    if (fs.existsSync(this.dbPath)) {
      try {
        const content = fs.readFileSync(this.dbPath, 'utf-8');
        if (!content.trim()) {
          console.warn(`[STORAGE] Warning: ${this.dbPath} is empty. Skipping load.`);
          return;
        }
        const parsed = JSON.parse(content);
        
        // Handle migration if projects missing
        this.data.projects = (parsed.projects || []).map((p: any) => ({
          ...p,
          createdAt: new Date(p.createdAt),
          updatedAt: new Date(p.updatedAt)
        }));

        this.data.items = (parsed.items || []).map((item: any) => ({
            ...item,
            createdAt: new Date(item.createdAt),
            updatedAt: new Date(item.updatedAt),
            history: (item.history || []).map((h: any) => ({
              ...h,
              timestamp: new Date(h.timestamp)
            }))
        }));

        this.data.snapshots = (parsed.snapshots || []).map((s: any) => ({
            ...s,
            pausedAt: new Date(s.pausedAt),
            resumedAt: s.resumedAt ? new Date(s.resumedAt) : undefined,
        }));
      } catch (e) {
        console.error(`[STORAGE] Error parsing ${this.dbPath}. Keeping current in-memory state.`, e);
      }
    } else {
      this.save();
    }
  }

  private save() {
    const tempPath = `${this.dbPath}.${Math.random().toString(36).substring(7)}.tmp`;
    try {
      fs.writeFileSync(tempPath, JSON.stringify(this.data, null, 2));
      fs.renameSync(tempPath, this.dbPath);
    } catch (e) {
      console.error(`[STORAGE] Critical Error saving to ${this.dbPath}`, e);
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    }
  }

  // Project Methods
  async createProject(project: Project): Promise<Project> {
    return this.runLocked(() => {
      this.load();
      this.data.projects.push(project);
      this.save();
      return project;
    });
  }

  async updateProject(id: string, updates: Partial<Project>): Promise<Project> {
    return this.runLocked(() => {
      this.load();
      const index = this.data.projects.findIndex(p => p.id === id);
      if (index === -1) throw new Error(`Project ${id} not found`);
      const updated = { ...this.data.projects[index], ...updates, updatedAt: new Date() };
      this.data.projects[index] = updated;
      this.save();
      return updated;
    });
  }

  async deleteProject(id: string): Promise<boolean> {
    return this.runLocked(() => {
      this.load();
      const index = this.data.projects.findIndex(p => p.id === id);
      if (index === -1) return false;
      this.data.projects.splice(index, 1);
      // Optional: Delete items belonging to project
      this.data.items = this.data.items.filter(i => i.projectId !== id);
      this.save();
      return true;
    });
  }

  async getProject(id: string): Promise<Project | null> {
    return this.runLocked(() => {
      this.load();
      return this.data.projects.find(p => p.id === id) || null;
    });
  }

  async listProjects(): Promise<Project[]> {
    return this.runLocked(() => {
      this.load();
      return [...this.data.projects];
    });
  }

  // Item Methods
  async createItem(item: AgenFKItem): Promise<AgenFKItem> {
    return this.runLocked(() => {
      this.load();
      
      // Initialize history if missing
      if (!item.history) {
        item.history = [];
      }
      
      // Record initial state
      item.history.push({
        id: uuidv4(),
        fromStatus: "TODO" as Status, // Default starting assumption
        toStatus: item.status,
        timestamp: new Date()
      });

      this.data.items.push(item);
      this.save();
      return item;
    });
  }

  async updateItem(id: string, updates: Partial<AgenFKItem>): Promise<AgenFKItem> {
    return this.runLocked(() => {
      this.load();
      const index = this.data.items.findIndex(i => i.id === id);
      if (index === -1) throw new Error(`Item ${id} not found`);

      const currentItem = this.data.items[index];
      
      // Record history if status changed
      if (updates.status !== undefined && updates.status !== currentItem.status) {
        const history = currentItem.history || [];
        history.push({
          id: uuidv4(),
          fromStatus: currentItem.status,
          toStatus: updates.status,
          timestamp: new Date()
        });
        updates.history = history;
      }

      const updatedItem = { ...currentItem, ...updates, updatedAt: new Date() };
      
      this.data.items[index] = updatedItem as AgenFKItem;
      this.save();
      return updatedItem as AgenFKItem;
    });
  }

  async deleteItem(id: string): Promise<boolean> {
    return this.runLocked(() => {
      this.load();
      const index = this.data.items.findIndex(i => i.id === id);
      if (index === -1) return false;

      this.data.items.splice(index, 1);
      this.save();
      return true;
    });
  }

  async getItem(id: string): Promise<AgenFKItem | null> {
    return this.runLocked(() => {
      this.load();
      const item = this.data.items.find(i => i.id === id);
      return item || null;
    });
  }

  async listItems(query?: StorageQuery): Promise<AgenFKItem[]> {
    return this.runLocked(() => {
      this.load();
      let items = this.data.items;

      if (query?.projectId) {
        items = items.filter(i => i.projectId === query.projectId);
      }
      if (query?.type) {
        items = items.filter(i => i.type === query.type);
      }
      if (query?.status) {
        items = items.filter(i => i.status === query.status);
      }
      if (query?.parentId) {
        items = items.filter(i => i.parentId === query.parentId);
      }

      // Pagination
      if (query?.offset !== undefined) {
        items = items.slice(query.offset);
      }
      if (query?.limit !== undefined) {
        items = items.slice(0, query.limit);
      }

      return [...items]; // Return copy to prevent external mutation before save
    });
  }

  async listChildren(parentId: string): Promise<AgenFKItem[]> {
      return this.listItems({ parentId });
  }

  // Snapshot Methods (pause/resume)
  async createSnapshot(snapshot: PauseSnapshot): Promise<PauseSnapshot> {
    return this.runLocked(() => {
      this.load();
      // Replace any existing snapshot for the same item
      this.data.snapshots = this.data.snapshots.filter(s => s.itemId !== snapshot.itemId);
      this.data.snapshots.push(snapshot);
      this.save();
      return snapshot;
    });
  }

  async getSnapshot(id: string): Promise<PauseSnapshot | null> {
    return this.runLocked(() => {
      this.load();
      return this.data.snapshots.find(s => s.id === id) || null;
    });
  }

  async getSnapshotByItemId(itemId: string): Promise<PauseSnapshot | null> {
    return this.runLocked(() => {
      this.load();
      return this.data.snapshots.find(s => s.itemId === itemId) || null;
    });
  }

  async deleteSnapshot(id: string): Promise<boolean> {
    return this.runLocked(() => {
      this.load();
      const index = this.data.snapshots.findIndex(s => s.id === id);
      if (index === -1) return false;
      this.data.snapshots.splice(index, 1);
      this.save();
      return true;
    });
  }
}
