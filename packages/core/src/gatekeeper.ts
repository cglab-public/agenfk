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

import { gateOnClaims, claimTreeOf } from './claimGate';

export interface GatekeeperFlow {
  /** Flow name, echoed back so the caller can see which flow is governing. */
  name?: string;
  steps: Array<{ name: string; order: number; isAnchor?: boolean; isSpecial?: boolean; exitCriteria?: string; autoCommit?: boolean | null; requireCommit?: boolean | null }>;
}

export interface GatekeeperItem {
  id: string;
  status: string;
  type: string;
  title?: string;
  branchName?: string;
  /** Paths this item owns while worked. See claimGate.ts. */
  claims?: string[];
  /** Tree resolution for claims (aaa01834): own worktree, else an ancestor's. */
  parentId?: string | null;
  worktreePath?: string | null;
  worktreeChoice?: string | null;
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
/**
 * A step that bounds the work rather than being work: an entry/exit anchor, or
 * a terminal/holding step like DONE, BLOCKED or ARCHIVED.
 *
 * isSpecial has to count, not just isAnchor. `agenfk flow create` only ever
 * asks "Is this a terminal/special step?" and emits isSpecial — it never sets
 * isAnchor — so a CLI-authored flow has a DONE-equivalent step that an isAnchor
 * filter cannot see. Worse, with no isAnchor step anywhere, an isAnchor-only
 * filter yields an EMPTY set, because the ['TODO','DONE'] fallback applies only
 * when there is no flow at all.
 *
 * Every question of the form "which steps are real work" goes through this, so
 * the answers cannot drift apart: getActiveStepItems decides whether an item is
 * in flight, resolveStepContract tells the agent which step to work, and a flow
 * where those two disagree is incoherent.
 */
export const isBoundaryStep = (s: { isAnchor?: boolean; isSpecial?: boolean }): boolean =>
  Boolean(s.isAnchor || s.isSpecial);

export function getActiveStepItems(
  items: GatekeeperItem[],
  flow: GatekeeperFlow | null,
): GatekeeperItem[] {
  const anchorNames = new Set(
    flow
      ? flow.steps.filter(isBoundaryStep).map(s => s.name.toUpperCase())
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
  /** The current step commits the card's work when it leaves (CGLAB-388). */
  commitOnLeave?: 'auto' | 'required';
  task: GatekeeperItem | null;
  /** True when authorization failed because multiple tasks were active. */
  ambiguous?: boolean;
  /**
   * Exit criteria of the step the authorized item currently sits on, when that
   * step defines any. Undefined on refusal, and undefined whenever
   * `criteriaState` is anything other than 'present'.
   */
  exitCriteria?: string;
  /**
   * WHY `exitCriteria` is absent. Absent criteria and unknowable criteria are
   * different facts and must not be reported with the same sentence: telling an
   * agent a step "defines no exit criteria" when the flow merely failed to load
   * asserts a bar does not exist when it was never looked up.
   */
  criteriaState?: 'present' | 'none-defined' | 'flow-unresolved' | 'status-not-in-flow';
  /** The governing flow, so a caller never has to guess the step names. */
  activeFlow?: { name?: string; steps: string[] };
  /** First non-anchor step. Resolved here so callers never re-derive it. */
  codingStep?: string;
  /** The step with no successor — last before the DONE anchor, or simply last. */
  finalStep?: string;
}

/** Resolved facts about where an item sits in its flow. */
export interface StepContract {
  exitCriteria?: string;
  criteriaState: 'present' | 'none-defined' | 'flow-unresolved' | 'status-not-in-flow';
  activeFlow?: { name?: string; steps: string[] };
  codingStep?: string;
  finalStep?: string;
  /** The step commits the card's work when it leaves (CGLAB-388), and whether it insists. */
  commitOnLeave?: 'auto' | 'required';
}

/**
 * What an agent is told about a step that commits on leave (CGLAB-388): the
 * gatekeeper and verify's reply both say it, so the agent stages first rather
 * than learning from a note after it moved on.
 */
export function commitOnLeaveNote(step: string, mode: 'auto' | 'required' | undefined): string {
  if (!mode) return '';
  return `📌 ${step} commits the card's staged, claimed files when it leaves: stage your work before you advance the card.`
    + (mode === 'required' ? ' It refuses to move on without that commit.' : '');
}

/**
 * Does leaving the step at `index` of these ORDERED steps end the flow? The
 * server's own rule for the close commit (verify's endsFlow): no next step, a
 * next step named DONE, or a next step that is the last and a boundary.
 */
export function leavingEndsFlow(sorted: ReadonlyArray<{ name: string; isAnchor?: boolean; isSpecial?: boolean }>, index: number): boolean {
  const next = sorted[index + 1];
  const exit = sorted[sorted.length - 1];
  return !next || next.name === 'DONE' || (next.name === exit?.name && isBoundaryStep(next));
}

/**
 * THE answer to "does leaving this step make a step commit?" (CGLAB-388): its
 * flags, except on the move that ends the flow, where the close commit takes
 * the work. The server's commit, the gatekeeper, verify's hints, flow
 * validation and the editor all ask this, so none of them can promise a
 * commit the server does not make.
 */
export function stepCommitsOnLeave(
  steps: ReadonlyArray<{ name: string; order: number; isAnchor?: boolean; isSpecial?: boolean; autoCommit?: unknown; requireCommit?: unknown }>,
  name: string,
): 'auto' | 'required' | undefined {
  const sorted = [...steps].sort((a, b) => a.order - b.order);
  const i = sorted.findIndex(s => s.name === name);
  if (i === -1 || leavingEndsFlow(sorted, i)) return undefined;
  return commitModeOf(sorted[i]);
}

/** A step's commit-on-leave mode, from its flags alone. */
export function commitModeOf(step: { autoCommit?: unknown; requireCommit?: unknown } | undefined): 'auto' | 'required' | undefined {
  if (step?.autoCommit !== true) return undefined;
  return step.requireCommit === true ? 'required' : 'auto';
}

/**
 * Resolve the step contract for `status` within `flow`.
 *
 * Shared by the `agenfk gatekeeper` CLI and the server's workflow_gatekeeper MCP
 * tool. Both MUST call this rather than reimplementing it: a hand-rolled copy in
 * the MCP handler is what let the shipped docs claim the CLI reported exit
 * criteria when it never did.
 */
export function resolveStepContract(
  flow: GatekeeperFlow | null | undefined,
  status: string,
): StepContract {
  const sorted = flow?.steps?.length ? [...flow.steps].sort((a, b) => a.order - b.order) : [];
  if (sorted.length === 0) {
    return { criteriaState: 'flow-unresolved' };
  }

  const activeFlow = { name: flow?.name, steps: sorted.map(s => s.name) };
  // Real working steps only. The previous version asked this twice with two
  // different hand-rolled predicates: `!s.isAnchor` (blind to isSpecial) and a
  // filter on the literal name 'DONE' (blind to any terminal step named
  // anything else). On a CLI-authored flow that made the coding step the
  // holding step and the final step the terminal one.
  const realSteps = sorted.filter(s => !isBoundaryStep(s));
  const codingStep = realSteps[0]?.name;
  // A flow with no real steps at all is degenerate, and its finalStep has been
  // "the last step that is not literally named DONE" for a long time. That
  // quirk is pinned by a test and is not what this fix is about, so it is
  // preserved verbatim: only flows that DO have working steps change.
  const degenerate = sorted.filter(s => s.name.toUpperCase() !== 'DONE');
  const finalStep = (
    realSteps.length ? realSteps : degenerate.length ? degenerate : sorted
  ).at(-1)?.name;

  const currentStep = sorted.find(s => s.name.toUpperCase() === status.toUpperCase());
  if (!currentStep) {
    return { criteriaState: 'status-not-in-flow', activeFlow, codingStep, finalStep };
  }

  const exitCriteria = currentStep.exitCriteria?.trim() || undefined;
  const commitOnLeave = stepCommitsOnLeave(sorted, currentStep.name);
  return {
    ...(commitOnLeave ? { commitOnLeave } : {}),
    exitCriteria,
    criteriaState: exitCriteria ? 'present' : 'none-defined',
    activeFlow,
    codingStep,
    finalStep,
  };
}

/**
 * Render a step contract as the text block appended to an authorization message.
 * `advanceHint` differs per surface (`agenfk verify ...` vs `validate_progress(...)`).
 */
export function renderStepContract(c: StepContract, status: string, advanceHint: string): string {
  let head: string;
  switch (c.criteriaState) {
    case 'present':
      head = `\n\nExit criteria for ${status}:\n${c.exitCriteria}\n→ Satisfy the above, then ${advanceHint}.`;
      break;
    case 'none-defined':
      head = `\n\nStep ${status} defines no exit criteria. That is not the same as "nothing required" — do the work the step is for, then ${advanceHint}.`;
      break;
    case 'status-not-in-flow':
      head = `\n\n⚠️ ${status} is not a step of the active flow, so there are no criteria to satisfy. The project's flow was probably changed while this item sat here. Check with \`agenfk flow show\` and move the item onto a step the flow defines.`;
      break;
    case 'flow-unresolved':
    default:
      head = `\n\n⚠️ Could not resolve this project's flow, so the exit criteria for ${status} are UNKNOWN — not absent. Load them with \`agenfk flow show --project <projectId> --json\` before advancing.`;
      break;
  }

  const steps = c.activeFlow
    ? `\n\nActive flow${c.activeFlow.name ? ` "${c.activeFlow.name}"` : ''}: ${c.activeFlow.steps.join(' → ')}`
      // Say what each step IS, never what to do on it. "Coding step: DISCOVERY"
      // read as an instruction to code on a discovery step (CGLAB-275); the
      // step's own exit criteria are the instructions. Names come from the flow
      // itself — the anchors are not assumed to be called TODO or DONE. The one
      // deliberate "do" is "omit the command": that is how the final gate runs
      // the project's verifyCommand, and getting it wrong skips the gate.
      + (c.codingStep ? `\nFirst working step (the step after ${c.activeFlow.steps[0]}): ${c.codingStep}` : '')
      + (c.finalStep ? `\nFinal step (omit the command here; the project's verifyCommand runs and closes the item): ${c.finalStep}` : '')
    : '';

  const commit = commitOnLeaveNote(status, c.commitOnLeave);
  return `${head}${commit ? `\n${commit}` : ''}${steps}`;
}

export interface GatekeeperDecisionOptions {
  /** Specific item id (full or prefix) to authorize against. */
  itemId?: string;
  /** Free-text description of the intended change, echoed back in the message. */
  intent?: string;
  /** Advisory role label (coding/review/testing/...). Echoed, NOT used as a status gate. */
  role?: string;
  /** The project's root: the tree of a card with no worktree (aaa01834). */
  projectRoot?: string | null;
}

/**
 * Decide whether work is authorized, mirroring the server's workflow_gatekeeper
 * semantics: work may proceed on a TASK, BUG, or STORY that sits in an active
 * working step of the project's active flow. Only an EPIC is never worked
 * directly (CGLAB-110: the shipped protocol decomposes EPICs into stories but
 * explicitly waives story→task decomposition — "A small story goes straight to
 * its first working step"). The `role` is advisory — it never gates on a
 * hardcoded status, so custom flows are honored.
 */
export function decideGatekeeperAuthorization(
  items: GatekeeperItem[],
  flow: GatekeeperFlow | null,
  opts: GatekeeperDecisionOptions = {},
): GatekeeperDecision {
  const intent = opts.intent || '(no intent provided)';
  const role = (opts.role || 'coding').toLowerCase();

  const workingItems = getActiveStepItems(items, flow);
  const actionable = workingItems.filter(i => i.type === 'TASK' || i.type === 'BUG' || i.type === 'STORY');

  if (actionable.length === 0) {
    const stuck = workingItems.find(i => i.type === 'EPIC');
    const hint = stuck
      ? ` "${stuck.title}" (${stuck.type}) is at step ${stuck.status}, but an EPIC is never worked directly. Create or advance a STORY, TASK or BUG within that EPIC to an active step first.`
      : ' Create or advance a STORY, TASK or BUG to an active step first.';
    return {
      authorized: false,
      task: null,
      message: `❌ WORKFLOW BREACH: No STORY, TASK or BUG is in an active working step.${hint}`,
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
    if (task.type === 'EPIC') {
      return {
        authorized: false,
        task: null,
        message: `❌ WORKFLOW BREACH: Cannot authorize work directly on an EPIC [${task.id.substring(0, 8)}] "${task.title}". An EPIC is never worked directly — create or advance a STORY, TASK or BUG within it to an active step first.`,
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
      message: `⚠️ AMBIGUOUS: Multiple items are in an active step. Provide --item-id to disambiguate:\n${list}`,
    };
  } else {
    task = actionable[0];
  }

  /*
   * The claim gate (819e7192), and it runs LAST: being on an active step is
   * the question of whether this card may work at all, and colliding with
   * somebody else is the question of whether it may work HERE. Answering the
   * second first would refuse a card for a file conflict when its real problem
   * is that it never started.
   *
   * Holders come from `items`, NOT `workingItems`. getActiveStepItems drops
   * PAUSED and BLOCKED, and a paused card is exactly the one whose half-edited
   * files must not be handed to somebody else - it finds out on resume, which
   * is the worst moment. claimGate decides release by terminal status instead.
   */
  // Claims are per worktree (aaa01834): each card carries the tree it works
  // in, and an unknown tree stays strict. See sameClaimTree.
  const byId = new Map(items.map(i => [i.id, i]));
  const treeOf = (i: GatekeeperItem) => claimTreeOf(i, id => byId.get(id), opts.projectRoot);
  const gate = gateOnClaims(
    { id: task.id, claims: task.claims, tree: treeOf(task) },
    items.map(i => ({ id: i.id, status: i.status, claims: i.claims, tree: treeOf(i) })),
  );
  if (!gate.authorized) {
    return {
      authorized: false,
      task: null,
      message: `❌ CLAIM CONFLICT on [${task.id.substring(0, 8)}] "${task.title}".\n\n${gate.message}`,
    };
  }

  // Surface the step contract via the shared resolver, so this and the MCP
  // handler cannot drift — that drift is what produced false claims in the docs.
  const contract = resolveStepContract(flow, task.status);
  const advanceHint = `advance with \`agenfk verify ${task.id.substring(0, 8)} --evidence "<what you did>"\``;
  // The label names the step the card is on (d26832d6 #11): CODING on a
  // test-authoring step read as leave to write the implementation.
  const stepRole = (flow as any)?.steps?.find((st: any) => st?.name === task!.status)?.role;
  const shown = (opts.role || (typeof stepRole === 'string' && stepRole) || role).toUpperCase();

  return {
    authorized: true,
    task,
    exitCriteria: contract.exitCriteria,
    criteriaState: contract.criteriaState,
    activeFlow: contract.activeFlow,
    codingStep: contract.codingStep,
    finalStep: contract.finalStep,
    ...(contract.commitOnLeave ? { commitOnLeave: contract.commitOnLeave } : {}),
    message: `✅ AUTHORIZED (${shown}).\n\n${task.type}: [${task.id.substring(0, 8)}] ${task.title}\nCurrent step: ${task.status}\nIntent: "${intent}"`
      + renderStepContract(contract, task.status, advanceHint),
  };
}
