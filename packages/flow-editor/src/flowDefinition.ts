/**
 * Client-side mirror of the Hub's flow-definition contract.
 *
 * BUG 269eeec8 (c): the Hub validates definition shape
 * (packages/hub/src/routes/admin.ts `validateDefinition` — every step needs a
 * non-empty id, a non-empty name, and a numeric order) while the local agenfk
 * server validated nothing. `makeBlankStep()` seeds a new step with `name: ''`,
 * so adding a step and saving before naming it produced a bare 400 from the Hub
 * and a silently-corrupt flow locally. An empty step name is a broken workflow
 * status either way: nothing can transition an item to "".
 *
 * Checking here means Save is blocked with a reason pinned to the offending
 * step, before any request goes out. Keep in step with the Hub's validator and
 * with the local server's `flowStepsError` (packages/server/src/server.ts) — the
 * cases in flowDefinition.test.ts are the contract.
 */
import type { FlowStep } from './types';

export interface FlowDefinitionIssue {
  /** Index into the steps array, or undefined for a flow-level problem. */
  stepIndex?: number;
  message: string;
}

/**
 * Every reason this definition would be rejected, in document order
 * (flow-level first, then per-step). Empty array means it will be accepted.
 */
export function flowDefinitionIssues(name: string, steps: FlowStep[]): FlowDefinitionIssue[] {
  const issues: FlowDefinitionIssue[] = [];

  if (!name.trim()) {
    issues.push({ message: 'Flow name is required.' });
  }
  if (!Array.isArray(steps) || steps.length === 0) {
    issues.push({ message: 'A flow needs at least one step.' });
    return issues;
  }

  // Only gate on what the user must fix themselves. Two of the Hub's rules are
  // deliberately NOT enforced here, because blocking on them would strand the
  // user in front of a field the editor does not expose:
  //  - step `id`: MCP create_flow never sent ids (its zod schema omits the key),
  //    so flows already in users' databases have steps — anchors included —
  //    without one. The server now backfills ids on write, and withStepIds()
  //    below fills them into the payload, so a missing id is not the user's
  //    problem to solve.
  //  - step `order`: the save payload rewrites order to the array index, so any
  //    bad value in loaded data is repaired by the request itself.
  steps.forEach((step, stepIndex) => {
    if (typeof step?.name !== 'string' || !step.name.trim()) {
      issues.push({ stepIndex, message: 'Step name is required.' });
    }
  });

  return issues;
}

/**
 * Fill in ids the loaded flow was missing, so the payload satisfies the Hub's
 * id rule without ever asking the user for a value the UI cannot edit. The
 * local server backfills too; doing it here also covers hub-ui, whose backend
 * rejects rather than generates.
 */
export function withStepIds(steps: FlowStep[], generateId: () => string): FlowStep[] {
  return steps.map(s => (typeof s?.id === 'string' && s.id ? s : { ...s, id: generateId() }));
}

/** The issue attached to a given step, if any — for rendering inline. */
export function stepIssue(issues: FlowDefinitionIssue[], stepIndex: number): FlowDefinitionIssue | undefined {
  return issues.find(i => i.stepIndex === stepIndex);
}
