// Copied from core for simplicity in MVP UI
export enum Status {
  IDEAS = "IDEAS",
  TODO = "TODO",
  IN_PROGRESS = "IN_PROGRESS",
  TEST = "TEST",
  REVIEW = "REVIEW",
  DONE = "DONE",
  BLOCKED = "BLOCKED",
  PAUSED = "PAUSED",
  ARCHIVED = "ARCHIVED"
}

export enum ItemType {
  EPIC = "EPIC",
  STORY = "STORY",
  TASK = "TASK",
  BUG = "BUG"
}

export interface TokenUsage {
  input: number;
  output: number;
  model: string;
  cost?: number;
}

export interface ContextItem {
  id: string;
  path: string;
  description?: string;
  content?: string;
}

export interface Project {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TestRecord {
  id: string;
  command: string;
  output: string;
  status: "PASSED" | "FAILED";
  executedAt: string;
}

export interface ReviewRecord {
  id: string;
  command: string;
  output: string;
  status: "PASSED" | "FAILED";
  executedAt: string;
}

export interface HistoryRecord {
  id: string;
  fromStatus: Status;
  toStatus: Status;
  timestamp: string;
  user?: string;
}

export interface CommentRecord {
  id: string;
  content: string;
  author: string;
  timestamp: string;
  step?: string;
}

export interface FlowStep {
  id: string;
  name: string;
  label: string;
  order: number;
  exitCriteria?: string;
  color?: string;         // Optional hex color for the step (e.g. "#3b82f6")
  icon?: string;          // Optional icon key (e.g. "zap", "check") for display in the Kanban column header
  isAnchor?: boolean;     // True for TODO (first) and DONE (last) — cannot be deleted or reordered
  /** @deprecated Use isAnchor instead. Kept for backwards compatibility. */
  isSpecial?: boolean;
}

export interface Flow {
  id: string;
  name: string;
  description?: string;
  version?: string;
  steps: FlowStep[];
  createdAt: string;
  updatedAt: string;
  // Ownership. The server sets 'hub' for flows synced from the org's Hub and
  // refuses local mutation of them; the UI must present those as read-only
  // (BUG 269eeec8 (b)). Absent on older payloads, so treat undefined as local.
  source?: 'local' | 'hub' | 'community';
  hubFlowId?: string;
}

export interface RegistryFlow {
  filename: string;
  name: string;
  author?: string;
  version?: string;
  stepCount: number;
  description?: string;
  steps?: { name: string; label: string }[];
}

export interface AgEnFKItem {
  id: string;
  projectId: string;
  type: ItemType;
  title: string;
  description: string;
  status: Status;
  assignee?: string;
  tokenUsage?: TokenUsage[];
  context?: ContextItem[];
  reviews?: ReviewRecord[];
  tests?: TestRecord[];
  history?: HistoryRecord[];
  comments?: CommentRecord[];
  createdAt: string; // Date comes as string from JSON
  updatedAt: string;
  parentId?: string;
  severity?: string;
  previousStatus?: Status;
  implementationPlan?: string;
  sortOrder?: number;
  // Nullable, because the API clears a tracker link by writing null rather than
  // by removing the field, and the UI keeps its own copy of this type rather
  // than importing @agenfk/core — so it was quietly describing a shape the API
  // no longer returns. No current call site dereferences these without a guard;
  // the point is that the type should not invite one.
  externalId?: string | null;
  externalUrl?: string | null;
  branchName?: string;
  prUrl?: string;
  prNumber?: number;
  prStatus?: 'open' | 'merged' | 'closed' | 'draft';
}
