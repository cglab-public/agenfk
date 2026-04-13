import { Flow, FlowStep } from "./types.js";

// Built-in default flow steps (TDD-oriented).
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
    id: "default-discovery",
    name: "DISCOVERY",
    label: "Discovery",
    order: 1,
    exitCriteria:
      "If the user request is not specific enough, questions must be asked so the details are good enough to start the implementation. Once you have all the information, cards at the right granularity (Epic, Story, Task or Bug) must be fully created. The user must give you the go-ahead before you move forward with the implementation.",
  },
  {
    id: "default-create-unit-tests",
    name: "CREATE_UNIT_TESTS",
    label: "Unit Tests",
    order: 2,
    exitCriteria:
      "All tests for the required functionality should be implemented so that they reflect future functionality — they can all fail at this point. Tests will guide the implementation itself. All code starts with the test. CRITICAL: it is not enough to test for the existence of source code; actual code behavior must be tested.",
  },
  {
    id: "default-in-progress",
    name: "IN_PROGRESS",
    label: "In Progress",
    order: 3,
    exitCriteria:
      "All tests are passing, because the functionality they test is actually implemented and working.",
  },
  {
    id: "default-review",
    name: "REVIEW",
    label: "Review",
    order: 4,
    exitCriteria:
      "Code is syntactically and semantically reviewed (including security aspects).",
  },
  {
    id: "default-done",
    name: "DONE",
    label: "Done",
    order: 5,
    isAnchor: true,
  },
];

export const DEFAULT_FLOW: Flow = {
  id: "default",
  name: "Default Flow",
  description:
    "The built-in AgEnFK workflow is TDD-based: TODO → DISCOVERY → CREATE_UNIT_TESTS → IN_PROGRESS → REVIEW → DONE. Tests are written first (and fail), then functionality is implemented to make them pass. Platform statuses (BLOCKED, PAUSED, IDEAS, ARCHIVED, TRASHED) are always reachable from any step.",
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
