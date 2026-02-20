import { AgenticItem, ItemType, Status } from './types';

export interface PluginConfig {
  [key: string]: any;
}

export interface AgenticPlugin {
  name: string;
  version: string;
  init(config: PluginConfig): Promise<void>;
  shutdown?(): Promise<void>;
}

export interface StorageQuery {
  type?: ItemType;
  status?: Status;
  parentId?: string;
  limit?: number;
  offset?: number;
}

export interface StorageProvider extends AgenticPlugin {
  createItem(item: AgenticItem): Promise<AgenticItem>;
  updateItem(id: string, updates: Partial<AgenticItem>): Promise<AgenticItem>;
  deleteItem(id: string): Promise<boolean>;
  getItem(id: string): Promise<AgenticItem | null>;
  listItems(query?: StorageQuery): Promise<AgenticItem[]>;
  listChildren(parentId: string): Promise<AgenticItem[]>;
}

export interface TokenTracker extends AgenticPlugin {
  trackUsage(itemId: string, input: number, output: number, model: string): Promise<void>;
  getUsage(itemId: string): Promise<any>; // Define stricter type later
}

export interface LLMProvider extends AgenticPlugin {
  generate(prompt: string, context?: any): Promise<string>;
}
