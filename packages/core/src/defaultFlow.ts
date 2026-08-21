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
    exitCriteria:
      "Implement the change. Explore the codebase first and confirm what already exists before claiming it does — search for the specific components, endpoints and queries rather than assuming. Keep the change focused on what was asked. For a defect, trace it from symptom to root cause and fix the cause, one fix at a time, rather than working around it. The project builds.",
  },
  {
    id: "default-review",
    name: "REVIEW",
    label: "Review",
    order: 2,
    exitCriteria:
      "Review everything you changed, and state what you reviewed. Re-read each modified file and check correctness, edge cases, error handling, input validation and authorization, and whether any test you touched still proves what its name claims. If the change is risky or wide, get the review from an independent reviewer rather than yourself — a review by the author carries the author's blind spots. Verify each finding against the code before acting on it, and say which findings you rejected and why.",
  },
  {
    id: "default-test",
    name: "TEST",
    label: "Test",
    order: 3,
    exitCriteria:
      "The project's full test suite passes, and the new behaviour is covered by tests that fail if the change is reverted. Report the actual numbers rather than 'tests pass'. Compare the test names before and after your work and confirm none was deleted, renamed away, skipped or had its assertions weakened — a green suite with fewer tests than you started with is a regression, not a pass.",
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
  description: "The built-in AgEnFK workflow: TODO → IN_PROGRESS → REVIEW → TEST → DONE. Platform statuses (BLOCKED, PAUSED, IDEAS, ARCHIVED, TRASHED) are always reachable from any step.",
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
