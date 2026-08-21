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
  /** Flow name, echoed back so the caller can see which flow is governing. */
  name?: string;
  steps: Array<{ name: string; order: number; isAnchor?: boolean; exitCriteria?: string }>;
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
 * Find an item by full id (preferred) or id-prefix across ALL items, ignoring
 * project scoping. An exact id match always wins over a prefix match. With a
 * colliding prefix the first prefix match (in input order) is returned — callers
 * that must not act on an ambiguous prefix should prefer an exact id or use
 * `detectCrossProjectItem`, which only treats a match as cross-project when no
 * in-project item matches.
 */
export function findItemAcrossProjects<T extends { id: string }>(
  items: T[],
  itemId: string | undefined,
): T | null {
  if (!itemId) return null;
  return items.find(i => i.id === itemId) ?? items.find(i => i.id.startsWith(itemId)) ?? null;
}

/**
 * Decide whether an explicit `--item-id` refers to an item in a DIFFERENT
 * project than the current working directory. Returns that item only when:
 *   - no item in the current project matches the id/prefix (so we don't
 *     short-circuit a legitimate in-project match on a colliding prefix), AND
 *   - a match exists in another project.
 * Otherwise returns null (let normal in-project authorization proceed).
 */
export function detectCrossProjectItem<T extends { id: string; projectId?: string }>(
  allItems: T[],
  itemId: string | undefined,
  currentProjectId: string | undefined,
): T | null {
  if (!itemId || !currentProjectId) return null;
  const inProject = allItems.find(
    i => i.projectId === currentProjectId && (i.id === itemId || i.id.startsWith(itemId)),
  );
  if (inProject) return null; // a valid in-project match exists — not cross-project
  const match = findItemAcrossProjects(allItems, itemId);
  if (match && match.projectId && match.projectId !== currentProjectId) return match;
  return null;
}

export interface GatekeeperDecision {
  authorized: boolean;
  message: string;
  task: GatekeeperItem | null;
  /** True when authorization failed because multiple tasks were active. */
  ambiguous?: boolean;
  /**
   * Exit criteria of the step the authorized item currently sits on, when that
   * step defines any. Undefined on refusal, and undefined when the step has no
   * criteria — the shipped default flow defines none, so callers must treat
   * absence as "no stated bar", never as "nothing required".
   */
  exitCriteria?: string;
  /** The governing flow, so a caller never has to guess the step names. */
  activeFlow?: { name?: string; steps: string[] };
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

  // Surface the step contract. The flow is already in hand here; discarding it
  // is what forced CLI-only agents to fetch criteria from a second command, and
  // what let the CLI and the MCP tool drift apart in the first place.
  const sorted = flow?.steps ? [...flow.steps].sort((a, b) => a.order - b.order) : [];
  const currentStep = sorted.find(s => s.name.toUpperCase() === task.status.toUpperCase());
  const exitCriteria = currentStep?.exitCriteria?.trim() || undefined;

  const activeFlow = sorted.length
    ? { name: flow?.name, steps: sorted.map(s => s.name) }
    : undefined;

  const criteriaBlock = exitCriteria
    ? `\n\nExit criteria for ${task.status}:\n${exitCriteria}\n→ Satisfy the above, then advance with \`agenfk verify ${task.id.substring(0, 8)} --evidence "<how you satisfied them>"\`.`
    : `\n\nStep ${task.status} defines no exit criteria. That is not the same as "nothing required" — do the work the step is for, then advance with \`agenfk verify ${task.id.substring(0, 8)} --evidence "<what you did>"\`.`;

  const flowBlock = activeFlow
    ? `\n\nActive flow${activeFlow.name ? ` "${activeFlow.name}"` : ''}: ${activeFlow.steps.join(' → ')}`
    : '';

  return {
    authorized: true,
    task,
    exitCriteria,
    activeFlow,
    message: `✅ AUTHORIZED (${role.toUpperCase()}).\n\n${task.type}: [${task.id.substring(0, 8)}] ${task.title}\nCurrent step: ${task.status}\nIntent: "${intent}"${criteriaBlock}${flowBlock}`,
  };
}
