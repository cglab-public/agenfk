import { v4 as uuidv4 } from "uuid";
import * as fs from 'fs';
import * as path from 'path';
import {
  StorageProvider,
  PluginConfig,
  StorageQuery,
  AgenticItem,
  Status,
  ItemType,
  BaseItem,
  TokenUsage,
  ContextItem
} from "@agentic/core";

interface JSONData {
  items: AgenticItem[];
}

export class JSONStorageProvider implements StorageProvider {
  name = "json-storage";
  version = "1.0.0";
  public dbPath: string = "";
  private data: JSONData = { items: [] };

  async init(config: PluginConfig): Promise<void> {
    this.dbPath = config.path || ".agentic/db.json";
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.load();
  }

  private load() {
    if (fs.existsSync(this.dbPath)) {
      try {
        const content = fs.readFileSync(this.dbPath, 'utf-8');
        const parsed = JSON.parse(content);
        // Revive dates
        this.data.items = parsed.items.map((item: any) => ({
            ...item,
            createdAt: new Date(item.createdAt),
            updatedAt: new Date(item.updatedAt)
        }));
      } catch (e) {
        console.error("Failed to parse DB, starting fresh", e);
        this.data = { items: [] };
      }
    } else {
      this.save();
    }
  }

  private save() {
    fs.writeFileSync(this.dbPath, JSON.stringify(this.data, null, 2));
  }

  async createItem(item: AgenticItem): Promise<AgenticItem> {
    this.load();
    this.data.items.push(item);
    this.save();
    return item;
  }

  async updateItem(id: string, updates: Partial<AgenticItem>): Promise<AgenticItem> {
    this.load();
    const index = this.data.items.findIndex(i => i.id === id);
    if (index === -1) throw new Error(`Item ${id} not found`);

    const currentItem = this.data.items[index];
    const updatedItem = { ...currentItem, ...updates, updatedAt: new Date() };
    
    this.data.items[index] = updatedItem as AgenticItem;
    this.save();
    return updatedItem as AgenticItem;
  }

  async deleteItem(id: string): Promise<boolean> {
    this.load();
    const index = this.data.items.findIndex(i => i.id === id);
    if (index === -1) return false;

    this.data.items.splice(index, 1);
    this.save();
    return true;
  }

  async getItem(id: string): Promise<AgenticItem | null> {
    this.load();
    const item = this.data.items.find(i => i.id === id);
    return item || null;
  }

  async listItems(query?: StorageQuery): Promise<AgenticItem[]> {
    this.load();
    let items = this.data.items;

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

    return items;
  }

  async listChildren(parentId: string): Promise<AgenticItem[]> {
      return this.listItems({ parentId });
  }
}
