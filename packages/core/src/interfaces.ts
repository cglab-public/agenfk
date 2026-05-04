import { AgEnFKItem, ItemType, Status, Project, PauseSnapshot, Flow } from './types';

export interface PluginConfig {
  [key: string]: any;
}

export interface AgEnFKPlugin {
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

export interface StorageProvider extends AgEnFKPlugin {
  // Projects
  createProject(project: Project): Promise<Project>;
  updateProject(id: string, updates: Partial<Project>): Promise<Project>;
  deleteProject(id: string): Promise<boolean>;
  getProject(id: string): Promise<Project | null>;
  listProjects(): Promise<Project[]>;

  // Items
  createItem(item: AgEnFKItem): Promise<AgEnFKItem>;
  updateItem(id: string, updates: Partial<AgEnFKItem>): Promise<AgEnFKItem>;
  deleteItem(id: string): Promise<boolean>;
  getItem(id: string): Promise<AgEnFKItem | null>;
  listItems(query?: StorageQuery): Promise<AgEnFKItem[]>;
  listChildren(parentId: string): Promise<AgEnFKItem[]>;

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

export interface TokenTracker extends AgEnFKPlugin {
  trackUsage(itemId: string, input: number, output: number, model: string): Promise<void>;
  getUsage(itemId: string): Promise<any>; // Define stricter type later
}

export interface LLMProvider extends AgEnFKPlugin {
  generate(prompt: string, context?: any): Promise<string>;
}

// ── Corporate Hub event envelope ─────────────────────────────────────────────
// Optional component: when an installation is configured to push to a corp hub
// (~/.agenfk/hub.json present), local mutations emit HubEvents that are buffered
// in a local outbox and flushed to the hub via HTTPS. Pure type definitions —
// no runtime imports — so this remains safe for browser consumers.

export type HubEventType =
  | 'item.created'
  | 'item.updated'
  | 'item.moved'
  | 'item.deleted'
  | 'item.closed'
  | 'step.transitioned'
  | 'validate.invoked'
  | 'validate.passed'
  | 'validate.failed'
  | 'comment.added'
  | 'test.logged'
  | 'tokens.logged'
  | 'session.started'
  | 'session.ended';

export interface HubActor {
  osUser: string;
  gitName: string | null;
  gitEmail: string | null;
}

export interface HubEvent {
  eventId: string;
  installationId: string;
  orgId: string;
  occurredAt: string; // ISO-8601 UTC
  receivedAt?: string; // set by hub on ingest
  actor: HubActor;
  projectId?: string;
  // Stable cross-installation project identity. Populated from the project's
  // `git remote get-url origin` (or repo equivalent) by the agenfk client.
  // Hub queries use this to group activity by repo across users.
  remoteUrl?: string | null;
  itemId?: string;
  // EPIC | STORY | TASK | BUG (when the event refers to an item).
  itemType?: string;
  type: HubEventType;
  payload: Record<string, unknown>;
}
