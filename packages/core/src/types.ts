export enum Status {
  TODO = "TODO",
  IN_PROGRESS = "IN_PROGRESS",
  REVIEW = "REVIEW",
  DONE = "DONE",
  BLOCKED = "BLOCKED",
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
  cost?: number; // Optional cost estimation
}

export interface ContextItem {
  id: string;
  path: string;
  description?: string;
  content?: string; // Optional full content, mostly for context window management
}

export interface ReviewRecord {
  id: string;
  command: string;
  output: string;
  status: "PASSED" | "FAILED";
  executedAt: Date;
}

export interface Project {
  id: string;
  name: string;
  description?: string;
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
  createdAt: Date;
  updatedAt: Date;
  parentId?: string; // For hierarchy (Story -> Epic, Task -> Story)
  previousStatus?: Status; // To restore status after unarchiving
  implementationPlan?: string; // Markdown implementation plan
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
