export declare enum Status {
    TODO = "TODO",
    IN_PROGRESS = "IN_PROGRESS",
    REVIEW = "REVIEW",
    DONE = "DONE",
    BLOCKED = "BLOCKED",
    ARCHIVED = "ARCHIVED"
}
export declare enum ItemType {
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
    projectId: string;
    type: ItemType;
    title: string;
    description: string;
    status: Status;
    assignee?: string;
    tokenUsage?: TokenUsage[];
    context?: ContextItem[];
    reviews?: ReviewRecord[];
    createdAt: Date;
    updatedAt: Date;
    parentId?: string;
    previousStatus?: Status;
    implementationPlan?: string;
}
export interface Epic extends BaseItem {
    type: ItemType.EPIC;
    children?: string[];
}
export interface Story extends BaseItem {
    type: ItemType.STORY;
    children?: string[];
    epicId?: string;
}
export interface Task extends BaseItem {
    type: ItemType.TASK;
    storyId?: string;
}
export interface Bug extends BaseItem {
    type: ItemType.BUG;
    storyId?: string;
    severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
}
export type AgenFKItem = Epic | Story | Task | Bug;
