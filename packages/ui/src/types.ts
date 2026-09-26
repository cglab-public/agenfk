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
  /** CGLAB-380: what the step is for, and the checks this flow adds to it. */
  role?: string | null;
  checks?: Array<{ id: string; params?: Record<string, string>; severity?: 'block' | 'warn' }> | null;
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
  source?: 'local' | 'hub' | 'community' | 'parent';
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

/**
 * A verify running on the card right now (9569b4d7). Derived by the server from
 * its live runs at response time, never stored: after a restart there is none.
 */
export interface ActiveRun {
  runId: string;
  step: string;
  startedAt: string;
}

/** The run's latest output, as the board reads it while the run lasts. */
export interface ActiveRunOutput extends ActiveRun {
  output: string;
}

export interface AgEnFKItem {
  /** A verify running on this card right now (9569b4d7). */
  activeRun?: ActiveRun;
  /** Which agent works this card. Lives on the item, not in localStorage. */
  agentId?: string;
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
