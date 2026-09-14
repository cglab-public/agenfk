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

/**
 * The agents a terminal can be opened with.
 *
 * Distinct from TokenClient above, and deliberately so: that one lists
 * harnesses that report token usage (it includes cursor and opencode, which
 * this app does not launch), while this one lists what the desktop can
 * actually spawn (it includes `shell`, which is not a harness at all).
 * Collapsing them would put a command we cannot run into a menu, or leave one
 * we do run out of validation.
 *
 * It lives in core because the SERVER has to validate it — a recorded session
 * naming something outside this set either fails at restore or becomes a way
 * to influence what gets spawned — while the COMMANDS stay in the desktop
 * package, which is the security boundary that owns them.
 *
 * packages/desktop/src/test/agents.test.ts asserts the two cannot drift.
 */
/**
 * A terminal the user had open, remembered so it can come back.
 *
 * The row outlives the process on purpose. Quitting is the case this exists
 * for, and a killed app runs no shutdown code — so "still recorded" is simply
 * what a session that was open looks like after the fact.
 */
export interface TerminalSession {
  id: string;
  itemId: string;
  projectId?: string;
  agentId: string;
  /**
   * The AGENT's own conversation id, which we generate and hand it at spawn.
   *
   * Not to be confused with the desktop's PTY handle, which is also called a
   * session id and is an entirely different thing: that one identifies a live
   * process and dies with it, this one identifies a conversation and is the
   * only reason a restored terminal is worth anything.
   *
   * Absent for agents that cannot be told their own id — codex has no flag for
   * it — and absent must read as "this one cannot be resumed", never as a
   * missing row.
   */
  agentSessionId?: string;
  openedAt: string;
}

export const TERMINAL_AGENT_IDS = ['claude-code', 'codex', 'gemini', 'pi', 'shell'] as const;
export type TerminalAgentId = typeof TERMINAL_AGENT_IDS[number];

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

/**
 * Settings that belong to the INSTALLATION, not to a project.
 *
 * Every field is optional in the wire payload and total here: a key nobody has
 * written reads as its documented default rather than as undefined, because a
 * missing setting is not a false setting and callers should never have to know
 * which of the two they got.
 *
 * Deliberately small. This is not a junk drawer — a value earns a place here
 * only when it is genuinely installation-wide. Per-project preferences stay on
 * the project, and per-run decisions (notably disabling an agent's permission
 * prompts) stay decisions, not stored state.
 */
export interface AppSettings {
  /**
   * Run agent sessions and terminals inside tmux, so they outlive the app.
   *
   * Off by default, and that default is a promise: every session that predates
   * the feature worked without it, so an upgrade must not change how anyone's
   * terminal behaves. Storing it says nothing about whether tmux exists — the
   * preference is the user's decision, availability is a fact about one
   * machine, and the two are combined at the point of use so a choice made on
   * a Mac is not erased by opening the app on Windows.
   */
  tmuxByDefault: boolean;
}

/*
 * Deliberately NOT here: whether agents start with their permission prompts
 * disabled.
 *
 * It was, for one commit, and an adversarial review caught what that meant.
 * Everything in AppSettings is written through an unauthenticated local HTTP
 * route, which is fine for a preference whose worst outcome is a terminal that
 * does or does not survive quitting. Disabling permission prompts is not that:
 * it changes the argv of every agent the app spawns afterwards, which is the
 * same class as `verifyCommand` — and verifyCommand has sat behind
 * VERIFY_TOKEN in this server for exactly this reason.
 *
 * A token would have matched the existing posture. Moving it is stronger and
 * simpler: the setting only ever affects terminals the DESKTOP spawns (a
 * browser has no terminals at all), so it lives in the desktop's own prefs,
 * reachable only through the preload IPC. No HTTP route can set it, with or
 * without a token. See packages/desktop/src/main/prefs.ts.
 */

/** What an unwritten settings store answers. Also the upgrade contract. */
export const DEFAULT_APP_SETTINGS: AppSettings = {
  tmuxByDefault: false,
};

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
  /** Give each item its own git worktree when it enters a working step (CGLAB-166). */
  autoWorktree?: boolean;
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
  /**
   * Directory of this item's git worktree (CGLAB-166), when it has one.
   * Recorded rather than derived so a caller can tell "never created" from
   * "created, then deleted by hand".
   */
  worktreePath?: string;
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
