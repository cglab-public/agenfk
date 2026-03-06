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
}

export interface FlowStep {
  id: string;
  name: string;
  label: string;
  order: number;
  exitCriteria?: string;
  isSpecial?: boolean;
}

export interface Flow {
  id: string;
  name: string;
  description?: string;
  projectId: string;
  steps: FlowStep[];
  createdAt: string;
  updatedAt: string;
}

export interface RegistryFlow {
  filename: string;
  name: string;
  author?: string;
  version?: string;
  stepCount: number;
  description?: string;
}

export interface AgenFKItem {
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
  externalId?: string;
  externalUrl?: string;
  branchName?: string;
  prUrl?: string;
  prNumber?: number;
  prStatus?: 'open' | 'merged' | 'closed' | 'draft';
}
