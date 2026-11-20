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

/** GH-389: token usage summed over a set of turns (mirrors @agenfk/core). */
export interface UsageTotals {
  turns: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  /** Only what the harnesses reported themselves (pi). */
  costUsd: number;
  /** Turns no harness priced: the board estimates them from its price table. */
  unpricedTurns: number;
}

export interface ModelUsage extends UsageTotals {
  client: string;
  model: string;
}

/** The usage of one stay in a step, recorded when the card left it. */
export interface StepUsage {
  step: string;
  to: string;
  enteredAt: string;
  leftAt: string;
  complete: boolean;
  byModel: ModelUsage[];
  total: UsageTotals;
}

/** GH-394: a project's usage on no card over its last `days` local days, from this installation. */
export interface NoCardUsage {
  projectId: string;
  days: number;
  since: string;
  total: UsageTotals;
  byModel: ModelUsage[];
  byDay: Array<{ day: string; total: UsageTotals; byModel: ModelUsage[] }>;
}

/** The card's usage when it closed, its sub-cards' included. */
export interface CardUsage {
  byModel: ModelUsage[];
  total: UsageTotals;
  byStep: Array<{ step: string; total: UsageTotals }>;
  cards: number;
  complete?: boolean;
  /** The step the card closed in; the total is current only while the card is still there. */
  atStatus?: string;
}

/** One ingested model turn (GET /token-events). */
export interface TokenEvent {
  id: string;
  ts: string;
  client: string;
  sessionId: string;
  model: string;
  input: number;
  cachedInput: number;
  cacheRead?: number;
  cacheWrite?: number;
  output: number;
  reasoning: number;
  total: number;
  costUsd?: number;
  itemId?: string;
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
  /**
   * The checkout this project lives in.
   *
   * Optional because a project can exist without one — and that is exactly the
   * state worth showing: with no folder an agent has nowhere to run and no
   * worktree can be cut. The server sets it; the browser cannot.
   */
  projectRoot?: string;
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

export interface ReviewRecord381 {
  id: string;
  at: string;
  reviewer: { client: string; sessionId: string; agentId: string | null; transcript: string };
  range: { from: string; to: string };
  findings: Array<{ title: string; state: 'fixed' | 'rejected'; severity?: 'HIGH' | 'MEDIUM' | 'LOW'; reason?: string }>;
  tree?: string | null;
  unreviewed?: unknown;
  unreviewedNotJudged?: unknown;
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
  /*
   * Ownership. The server sets 'hub' for flows synced from the org's Hub and
   * refuses local mutation of them; the UI must present those as read-only
   * (BUG 269eeec8 (b)). Absent on older payloads, so treat undefined as local.
   *
   * `parent` — a flow a parent hub dispatched to this hub, read-only here —
   * belongs to the SHARED type in packages/flow-editor, which this copy has to
   * accept: the UI's FlowEditorModal is a thin re-export of that component and
   * hands it these values. The two lists drifting apart is what broke the
   * build, and it will drift again while the type is written twice.
   */
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

/** 3aea49f1: what a running verify is doing (server: VerifyPhase, plus a wait on a person). */
export type VerifyRunPhase =
  | { state: 'checking' }
  | { state: 'queued'; ahead: number }
  | { state: 'running'; kind: 'whole' | 'affected' | 'tests-only' | 'reused'; files?: number }
  | { state: 'waiting'; on: 'report' | 'identical-run' | 'sibling' }
  | { state: 'awaiting-person' };

/** 3aea49f1: one verify running now, in any project (GET /verify-runs, the 'verify_runs' event). */
export interface VerifyRunEntry {
  runId?: string;
  itemId: string;
  title?: string;
  projectId?: string;
  projectName?: string;
  step: string;
  startedAt: string;
  phase: VerifyRunPhase;
  lastLine?: string;
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
  /** GH-389: usage of each step the card left. Server-written. */
  usageByStep?: StepUsage[];
  /** GH-389: the card's usage when it closed. Server-written. */
  cardUsage?: CardUsage;
  context?: ContextItem[];
  reviews?: ReviewRecord[];
  /** Independent reviews of this card (CGLAB-381); the reviewer is read from its transcript. Server-written only. */
  reviewRecords?: ReviewRecord381[];
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
