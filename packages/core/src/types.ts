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

// ── Observability: per-turn token telemetry from session-log ingestion ───────
// Populated by packages/server/src/token-ingestion. Replaces agent-self-reported
// per-item token logging entirely.

export type TokenClient =
  | 'claude-code'
  | 'codex'
  | 'gemini'
  | 'cursor'
  | 'opencode'
  | 'pi';

export interface TokenEvent {
  id: string;
  ts: string;                 // ISO timestamp of the model turn
  client: TokenClient;
  sessionId: string;
  turnId?: string;
  model: string;
  input: number;
  cachedInput: number;
  output: number;
  reasoning: number;
  total: number;
  itemId?: string;            // attribution (most-recent active item at ts)
  projectId?: string;
  cwd?: string;                // ingestion-only metadata used before attribution
  sourcePath: string;         // absolute path of the session log file
  sourceOffset: number;       // byte/line offset within the file (dedup key)
}

export interface TokenEventQuery {
  itemId?: string;
  projectId?: string;
  since?: string;
  until?: string;
  client?: TokenClient;
  limit?: number;
}

export interface IngestionState {
  sourcePath: string;
  lastOffset: number;
  lastRunAt: string;
}

// ── Agent Runs: orchestrated worker transcripts per item ────────────────────

export type RunActor = 'orchestrator' | 'worker' | 'reviewer';
export type RunStatus = 'running' | 'done' | 'failed';

export interface AgentRun {
  id: string;
  itemId: string;
  projectId?: string;
  step: string;                 // flow step the run served (e.g. CREATE_UNIT_TESTS)
  actor: RunActor;              // primary lane for the run
  harness: string;              // e.g. "pi", "claude-code"
  model: string;                // e.g. "qwen3.6:27b"
  sessionId?: string;           // worker session id (pi --session-id)
  sourcePath?: string;          // absolute path of the worker session JSONL (for tailing)
  status: RunStatus;
  verdict?: string;             // orchestrator verdict on the hand-off
  startedAt: string;            // ISO
  endedAt?: string;             // ISO
}

export type RunEventKind = 'dispatch' | 'think' | 'tool' | 'result' | 'diff' | 'verdict' | 'note';

export interface RunEvent {
  id: string;
  runId: string;
  seq: number;                  // monotonic order within the run
  ts: string;                   // ISO
  lane: RunActor;
  kind: RunEventKind;
  tool?: string;                // for kind==='tool': read|bash|write|edit…
  text?: string;                // human-readable text
  payload?: string;             // JSON blob for structured extras (args, diff, etc.)
  tokens?: number;              // optional per-event token count
}

export interface AgentRunQuery {
  itemId?: string;
  projectId?: string;
  status?: RunStatus;
  limit?: number;
}

// ── Observability: PR sizing (agent-declared, server-shadowed) ──────────────

export interface PrSizing {
  epic: number;
  story: number;
  task: number;
  bug: number;
}

export interface Pr {
  id: string;
  prNumber: number;
  repo: string;              // e.g. "owner/repo"
  itemId: string;
  openedAt: string;
  sizing: PrSizing;          // agent-declared
  sizingDeclaredAt: string;
  sizingShadow?: PrSizing;   // server-computed from item tree, sanity check only
  lastSizingCheckAt?: string;
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
  step?: string;
}

export interface Project {
  id: string;
  name: string;
  description?: string;
  verifyCommand?: string; // Project-level verification command (e.g. "npm run build && npm test")
  flowId?: string;        // ID of the active Flow for this project (falls back to DEFAULT_FLOW)
  projectRoot?: string;   // Absolute path to the project's root directory (set automatically by MCP on validate)
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

export type AgEnFKItem = Epic | Story | Task | Bug;

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
  color?: string;         // Optional hex color for the step (e.g. "#3b82f6")
  icon?: string;          // Optional icon key (e.g. "zap", "check") for display in the Kanban column header
  isAnchor?: boolean;     // True for TODO (first) and DONE (last) — cannot be deleted or reordered
  /** @deprecated Use isAnchor instead. Kept for backwards compatibility. */
  isSpecial?: boolean;    // True for terminal steps like DONE, BLOCKED, ARCHIVED
}

export interface Flow {
  id: string;
  name: string;
  description?: string;
  version?: string;
  steps: FlowStep[];
  createdAt: Date;
  updatedAt: Date;
  /** Origin of the flow row. 'local' (default) is editable on the client; 'hub' is read-only and reconciled from a corp Hub. */
  source?: 'local' | 'hub';
  /** Hub's flow id when source='hub'. Used by the reconciler to map remote → local. */
  hubFlowId?: string;
  /** Monotonic version number on the Hub side; bumps on every Hub-side update. */
  hubVersion?: number;
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
