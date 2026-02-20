// Copied from core for simplicity in MVP UI
export enum Status {
  TODO = "TODO",
  IN_PROGRESS = "IN_PROGRESS",
  REVIEW = "REVIEW",
  DONE = "DONE",
  BLOCKED = "BLOCKED"
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

export interface AgenticItem {
  id: string;
  type: ItemType;
  title: string;
  description: string;
  status: Status;
  assignee?: string;
  tokenUsage?: TokenUsage[];
  context?: ContextItem[];
  createdAt: string; // Date comes as string from JSON
  updatedAt: string;
  parentId?: string;
  severity?: string;
  implementationPlan?: string;
}
