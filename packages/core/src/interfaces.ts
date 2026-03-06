import { AgenFKItem, ItemType, Status, Project, PauseSnapshot, Flow } from './types';

export interface PluginConfig {
  [key: string]: any;
}

export interface AgenFKPlugin {
  name: string;
  version: string;
  init(config: PluginConfig): Promise<void>;
  shutdown?(): Promise<void>;
}

export interface StorageQuery {
  projectId?: string;
  type?: ItemType;
  status?: Status;
  parentId?: string;
  limit?: number;
  offset?: number;
}

export interface StorageProvider extends AgenFKPlugin {
  // Projects
  createProject(project: Project): Promise<Project>;
  updateProject(id: string, updates: Partial<Project>): Promise<Project>;
  deleteProject(id: string): Promise<boolean>;
  getProject(id: string): Promise<Project | null>;
  listProjects(): Promise<Project[]>;

  // Items
  createItem(item: AgenFKItem): Promise<AgenFKItem>;
  updateItem(id: string, updates: Partial<AgenFKItem>): Promise<AgenFKItem>;
  deleteItem(id: string): Promise<boolean>;
  getItem(id: string): Promise<AgenFKItem | null>;
  listItems(query?: StorageQuery): Promise<AgenFKItem[]>;
  listChildren(parentId: string): Promise<AgenFKItem[]>;

  // Snapshots (pause/resume)
  createSnapshot(snapshot: PauseSnapshot): Promise<PauseSnapshot>;
  getSnapshot(id: string): Promise<PauseSnapshot | null>;
  getSnapshotByItemId(itemId: string): Promise<PauseSnapshot | null>;
  deleteSnapshot(id: string): Promise<boolean>;

  // Flows
  createFlow(flow: Flow): Promise<Flow>;
  updateFlow(id: string, updates: Partial<Flow>): Promise<Flow>;
  deleteFlow(id: string): Promise<boolean>;
  getFlow(id: string): Promise<Flow | null>;
  listFlows(): Promise<Flow[]>;
}

export interface TokenTracker extends AgenFKPlugin {
  trackUsage(itemId: string, input: number, output: number, model: string): Promise<void>;
  getUsage(itemId: string): Promise<any>; // Define stricter type later
}

export interface LLMProvider extends AgenFKPlugin {
  generate(prompt: string, context?: any): Promise<string>;
}
