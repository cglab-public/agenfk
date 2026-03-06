export enum Status {
  IDEAS = "IDEAS",
  TODO = "TODO",
  IN_PROGRESS = "IN_PROGRESS",
  TEST = "TEST",
  REVIEW = "REVIEW",
  DONE = "DONE",
  BLOCKED = "BLOCKED",
  PAUSED = "PAUSED",
  ARCHIVED = "ARCHIVED",
  TRASHED = "TRASHED"
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
  sessionId?: string;   // Deduplication key
  source?: string;      // "claude-code" | "opencode" | "manual"
  timestamp?: string;   // ISO date when logged
}

export interface ContextItem {
  id: string;
  path: string;
  description?: string;
  content?: string; // Optional full content, mostly for context window management
}

export interface TestRecord {
  id: string;
  command: string;
  output: string;
  status: "PASSED" | "FAILED";
  executedAt: Date;
}

export interface ReviewRecord {
  id: string;
  command: string;
  output: string;
  status: "PASSED" | "FAILED";
  executedAt: Date;
}

export interface HistoryRecord {
  id: string;
  fromStatus: Status;
  toStatus: Status;
  timestamp: Date;
  user?: string; // Optional for future use
}

export interface CommentRecord {
  id: string;
  content: string;
  author: string;
  timestamp: Date;
}

export interface Project {
  id: string;
  name: string;
  description?: string;
  verifyCommand?: string; // Project-level verification command (e.g. "npm run build && npm test")
  flowId?: string;        // ID of the active Flow for this project (falls back to DEFAULT_FLOW)
  createdAt: Date;
  updatedAt: Date;
}

export interface BaseItem {
  id: string;
  projectId: string; // Every item belongs to a project
  type: ItemType;
  title: string;
  description: string;
  status: Status;
  assignee?: string;
  tokenUsage?: TokenUsage[]; // Array to track usage over time/sessions
  context?: ContextItem[];
  reviews?: ReviewRecord[];
  tests?: TestRecord[];
  history?: HistoryRecord[];
  comments?: CommentRecord[];
  createdAt: Date;
  updatedAt: Date;
  parentId?: string; // For hierarchy (Story -> Epic, Task -> Story)
  previousStatus?: Status; // To restore status after unarchiving
  implementationPlan?: string; // Markdown implementation plan
  sortOrder?: number; // Position within column for prioritization
  externalId?: string; // Reference to external systems (e.g. JIRA key)
  externalUrl?: string; // Link to external system
  branchName?: string; // Git branch associated with this item
  prUrl?: string; // Pull request URL
  prNumber?: number; // Pull request number
  prStatus?: 'open' | 'merged' | 'closed' | 'draft'; // Pull request status
}

export interface Epic extends BaseItem {
  type: ItemType.EPIC;
  children?: string[]; // IDs of Stories
}

export interface Story extends BaseItem {
  type: ItemType.STORY;
  children?: string[]; // IDs of Tasks/Bugs
  epicId?: string; // Parent Epic
}

export interface Task extends BaseItem {
  type: ItemType.TASK;
  storyId?: string; // Parent Story
}

export interface Bug extends BaseItem {
  type: ItemType.BUG;
  storyId?: string; // Parent Story
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
}

export type AgenFKItem = Epic | Story | Task | Bug;

// ── GitHub Integration ──────────────────────────────────────────────

export interface GitHubRepoMapping {
  owner: string;
  repo: string;
}

/** Stored in ~/.agenfk/config.json under the "github" key */
export interface GitHubConfig {
  repos: Record<string, GitHubRepoMapping>; // keyed by projectId
}

// ── Flow Model ───────────────────────────────────────────────────────────────

export interface FlowStep {
  id: string;
  name: string;           // Internal name / key (e.g. "in_progress")
  label: string;          // Display label (e.g. "In Progress")
  order: number;          // Sort position in the flow
  exitCriteria?: string;  // Human-readable criteria to leave this step
  isAnchor?: boolean;     // True for TODO (first) and DONE (last) — cannot be deleted or reordered
  /** @deprecated Use isAnchor instead. Kept for backwards compatibility. */
  isSpecial?: boolean;    // True for terminal steps like DONE, BLOCKED, ARCHIVED
}

export interface Flow {
  id: string;
  name: string;
  description?: string;
  projectId: string;      // Flows are scoped to a project
  steps: FlowStep[];
  createdAt: Date;
  updatedAt: Date;
}

export interface PauseSnapshot {
  id: string;
  itemId: string;
  projectId: string;
  status: Status;                // Item's status at time of pause
  summary: string;               // Agent-written summary of work done and what's left
  filesModified: string[];       // List of files changed
  branchName?: string;           // Git branch at pause time
  gitDiff?: string;              // Condensed diff of uncommitted changes
  resumeInstructions: string;    // Agent-written instructions for the next agent
  pausedAt: Date;
  resumedAt?: Date;              // Set when resumed
}
