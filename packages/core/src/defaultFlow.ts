import { Flow, FlowStep } from "./types.js";

// Built-in default flow steps.
// BLOCKED, PAUSED, IDEAS, ARCHIVED, TRASHED are platform-level statuses — NOT flow steps.
// They are always reachable from any step, hardcoded in the server transition layer.
const DEFAULT_STEPS: FlowStep[] = [
  {
    id: "default-todo",
    name: "TODO",
    label: "To Do",
    order: 0,
    isAnchor: true,
  },
  {
    id: "default-in-progress",
    name: "IN_PROGRESS",
    label: "In Progress",
    order: 1,
  },
  {
    id: "default-review",
    name: "REVIEW",
    label: "Review",
    order: 2,
  },
  {
    id: "default-test",
    name: "TEST",
    label: "Test",
    order: 3,
  },
  {
    id: "default-done",
    name: "DONE",
    label: "Done",
    order: 4,
    isAnchor: true,
  },
];

export const DEFAULT_FLOW: Flow = {
  id: "default",
  name: "Default Flow",
  description: "The built-in AgenFK workflow: TODO → IN_PROGRESS → REVIEW → TEST → DONE. Platform statuses (BLOCKED, PAUSED, IDEAS, ARCHIVED, TRASHED) are always reachable from any step.",
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
