import { Flow, FlowStep } from "./types.js";

// Built-in default flow steps
const DEFAULT_STEPS: FlowStep[] = [
  {
    id: "default-ideas",
    name: "IDEAS",
    label: "Ideas",
    order: 0,
    isSpecial: true,
  },
  {
    id: "default-todo",
    name: "TODO",
    label: "To Do",
    order: 1,
  },
  {
    id: "default-in-progress",
    name: "IN_PROGRESS",
    label: "In Progress",
    order: 2,
  },
  {
    id: "default-review",
    name: "REVIEW",
    label: "Review",
    order: 3,
  },
  {
    id: "default-test",
    name: "TEST",
    label: "Test",
    order: 4,
  },
  {
    id: "default-done",
    name: "DONE",
    label: "Done",
    order: 5,
  },
  {
    id: "default-blocked",
    name: "BLOCKED",
    label: "Blocked",
    order: 6,
    isSpecial: true,
  },
  {
    id: "default-paused",
    name: "PAUSED",
    label: "Paused",
    order: 7,
    isSpecial: true,
  },
  {
    id: "default-archived",
    name: "ARCHIVED",
    label: "Archived",
    order: 8,
    isSpecial: true,
  },
  {
    id: "default-trashed",
    name: "TRASHED",
    label: "Trashed",
    order: 9,
    isSpecial: true,
  },
];

export const DEFAULT_FLOW: Flow = {
  id: "default",
  name: "Default Flow",
  description: "The built-in AgenFK workflow: IDEAS → TODO → IN_PROGRESS → REVIEW → TEST → DONE, with special steps BLOCKED, PAUSED, ARCHIVED, TRASHED.",
  projectId: "__builtin__",
  steps: DEFAULT_STEPS,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

/**
 * Returns the Flow matching the given `flowId` from `flows`, or `DEFAULT_FLOW`
 * if `flowId` is undefined or no matching flow is found.
 */
export function getActiveFlow(flowId: string | undefined, flows: Flow[]): Flow {
  if (flowId === undefined) {
    return DEFAULT_FLOW;
  }
  const found = flows.find((f) => f.id === flowId);
  return found ?? DEFAULT_FLOW;
}
