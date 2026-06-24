/**
 * Pure, flow-aware gatekeeper decision logic — shared by the server's
 * workflow_gatekeeper MCP tool and the `agenfk gatekeeper` CLI command so they
 * agree on a single definition of "active working step".
 *
 * Historically the CLI reimplemented this with hardcoded status names
 * (IN_PROGRESS/REVIEW/TEST), which falsely reported a WORKFLOW BREACH whenever a
 * project used a custom flow (e.g. a TDD flow whose first coding step is
 * CREATE_UNIT_TESTS). Centralising the logic here kills that drift.
 */

export interface GatekeeperFlow {
  steps: Array<{ name: string; order: number; isAnchor?: boolean }>;
}

export interface GatekeeperItem {
  id: string;
  status: string;
  type: string;
  title?: string;
  branchName?: string;
}

/** Statuses that are never considered "active working" steps regardless of flow. */
export const INACTIVE_STATUSES = new Set(['BLOCKED', 'PAUSED', 'TRASHED', 'ARCHIVED', 'IDEAS']);

/**
 * Returns all items currently in any active working step — i.e. any step that
 * is not an anchor (TODO/DONE) and not a special inactive status.
 *
 * This replaces the old single-step-name approach that broke multi-step coding
 * flows (e.g. TDD flows where both 'create_unit_tests' and 'IN_PROGRESS' are
 * valid working steps).
 */
export function getActiveStepItems(
  items: GatekeeperItem[],
  flow: GatekeeperFlow | null,
): GatekeeperItem[] {
  const anchorNames = new Set(
    flow
      ? flow.steps.filter(s => s.isAnchor).map(s => s.name.toUpperCase())
      : ['TODO', 'DONE'],
  );
  return items.filter(i => {
    const upper = i.status.toUpperCase();
    return !anchorNames.has(upper) && !INACTIVE_STATUSES.has(upper);
  });
}

/**
 * Find an item by full id or unambiguous prefix across ALL items, ignoring
 * project scoping. Used by `agenfk gatekeeper --item-id`: when the caller names
 * an item explicitly, it should be resolvable even if it lives in a different
 * project than the current working directory — so the gatekeeper can give a
 * clear "wrong project" diagnostic instead of a misleading "not in an active
 * working step" breach.
 */
export function findItemAcrossProjects<T extends { id: string }>(
  items: T[],
  itemId: string | undefined,
): T | null {
  if (!itemId) return null;
  return items.find(i => i.id === itemId || i.id.startsWith(itemId)) ?? null;
}

export interface GatekeeperDecision {
  authorized: boolean;
  message: string;
  task: GatekeeperItem | null;
  /** True when authorization failed because multiple tasks were active. */
  ambiguous?: boolean;
}

export interface GatekeeperDecisionOptions {
  /** Specific item id (full or prefix) to authorize against. */
  itemId?: string;
  /** Free-text description of the intended change, echoed back in the message. */
  intent?: string;
  /** Advisory role label (coding/review/testing/...). Echoed, NOT used as a status gate. */
  role?: string;
}

/**
 * Decide whether work is authorized, mirroring the server's workflow_gatekeeper
 * semantics: work may only proceed on a TASK or BUG that sits in an active
 * working step of the project's active flow. The `role` is advisory — it never
 * gates on a hardcoded status, so custom flows are honored.
 */
export function decideGatekeeperAuthorization(
  items: GatekeeperItem[],
  flow: GatekeeperFlow | null,
  opts: GatekeeperDecisionOptions = {},
): GatekeeperDecision {
  const intent = opts.intent || '(no intent provided)';
  const role = (opts.role || 'coding').toLowerCase();

  const workingItems = getActiveStepItems(items, flow);
  const actionable = workingItems.filter(i => i.type === 'TASK' || i.type === 'BUG');

  if (actionable.length === 0) {
    const stuck = workingItems.find(i => i.type === 'STORY' || i.type === 'EPIC');
    const hint = stuck
      ? ` "${stuck.title}" (${stuck.type}) is at step ${stuck.status}, but work must be authorized on a TASK or BUG. Create or advance a TASK or BUG within that ${stuck.type} to an active step first.`
      : ' Create or advance a TASK or BUG to an active step first.';
    return {
      authorized: false,
      task: null,
      message: `❌ WORKFLOW BREACH: No TASK or BUG is in an active working step.${hint}`,
    };
  }

  let task: GatekeeperItem | undefined;
  if (opts.itemId) {
    task = workingItems.find(i => i.id === opts.itemId || i.id.startsWith(opts.itemId!));
    if (!task) {
      return {
        authorized: false,
        task: null,
        message: `❌ WORKFLOW BREACH: Item [${opts.itemId}] is not in an active working step.`,
      };
    }
    if (task.type === 'EPIC' || task.type === 'STORY') {
      return {
        authorized: false,
        task: null,
        message: `❌ WORKFLOW BREACH: Cannot authorize work directly on a ${task.type} [${task.id.substring(0, 8)}] "${task.title}". Create or advance a TASK or BUG within this ${task.type} to an active step first.`,
      };
    }
  } else if (actionable.length > 1) {
    const list = actionable
      .map(i => `  • [${i.id.substring(0, 8)}] ${i.title} (${i.status})`)
      .join('\n');
    return {
      authorized: false,
      ambiguous: true,
      task: null,
      message: `⚠️ AMBIGUOUS: Multiple tasks are in an active step. Provide --item-id to disambiguate:\n${list}`,
    };
  } else {
    task = actionable[0];
  }

  return {
    authorized: true,
    task,
    message: `✅ AUTHORIZED (${role.toUpperCase()}).\n\n${task.type}: [${task.id.substring(0, 8)}] ${task.title}\nCurrent step: ${task.status}\nIntent: "${intent}"`,
  };
}
