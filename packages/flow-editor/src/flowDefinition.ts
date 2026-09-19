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
  /*
   * TWO STEPS, ONE KEY. Nothing downstream dedupes names — not this file, not
   * `flowStepsError` on the server, not the Hub's validator, and
   * `normalizeFlowSteps` explicitly dedupes IDS and leaves names alone. With
   * [TODO, REVIEW, REVIEW, DONE] the server finds the FIRST match for an
   * item's status and advances to `index + 1`, which is called REVIEW too, so
   * the item verifies into the status it is already in and DONE is
   * unreachable. The board then draws two columns keyed on the same status.
   *
   * It was always possible to type a duplicate; it became easy once the key
   * was derived, because "Review" and "review" LOOK like two steps.
   */
  const seenNames = new Map<string, number>();

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
      return;
    }
    // Case-insensitively, because the server matches a status exactly but a
    // person reading two rows called REVIEW and review sees one mistake, not
    // two steps. Pinned to the SECOND one: the first is where the name was
    // established and the second is the one to rename.
    const key = step.name.trim().toUpperCase();
    const first = seenNames.get(key);
    if (first !== undefined) {
      issues.push({ stepIndex, message: `Step name "${step.name.trim()}" repeats step ${first + 1}. Two steps cannot share a key.` });
    } else {
      seenNames.set(key, stepIndex);
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

/**
 * The step key, derived from what the step is called.
 *
 * The editor used to ask for both: a bordered input for `PLAN_LOCAL` and
 * another for `Plan (local)`, stacked, which made the key look like a second
 * thing to invent rather than a spelling of the first. The artifact
 * (aca414c7 §01) draws them as ONE cell — the key over a small label — and the
 * read-only branch of the editor already rendered exactly that.
 *
 * The rule is not new. Every step of the flow this was reported against comes
 * back out of its own label: Plan (local) -> PLAN_LOCAL, Validate (local) ->
 * VALIDATE_LOCAL, Review -> REVIEW, Docker (local) -> DOCKER_LOCAL.
 *
 * A label with no word characters derives to the empty string rather than to
 * "___", because empty is already refused by `flowDefinitionIssues` with a
 * message pinned to the step, while a name of underscores would pass that
 * check and be unusable as a status.
 */
export function deriveStepName(label: string): string {
  return label
    // Fold the accent, keep the letter. Without this a Portuguese flow — the
    // first language this was reported in — turns "Validação (local)" into
    // VALIDA_O_LOCAL: the tilde is not alphanumeric, so the vowel it sat on
    // was replaced by a separator rather than kept.
    // Only where an accent MEANS a variant of a Latin letter. Stripping every
    // combining mark turned レビュー into レヒュ: in Japanese the dakuten is a
    // combining mark too, and it changes which character this is rather than
    // decorating one. NFC puts the rest back together.
    .normalize('NFD').replace(/(\p{Script=Latin})\p{M}+/gu, '$1').normalize('NFC')
    // Letters and numbers from ANY script, not [A-Za-z0-9]. Under ASCII-only,
    // "Проверка" and "レビュー" both derived to the empty string, and with no
    // key field left there was no way to author that flow at all.
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

/**
 * What the key becomes when the label changes.
 *
 * RENAMING A STEP IS NOT COSMETIC, and the first version of this got the
 * dividing line wrong. It let the key follow the label whenever the two were
 * still in sync — which is every key the default flow ships (IN_PROGRESS over
 * "In Progress", REVIEW over "Review"), so the common case was the unprotected
 * one. Retitling a step of a live flow rewrote its key, `PUT /flows/:id` does
 * not migrate items across a renamed step, and every item sitting on the old
 * status fell outside the flow: `validate_progress` refuses it outright and
 * the only way back is a rollback to the first step.
 *
 * So the line is PERSISTENCE, not similarity. A key that has been saved is a
 * status that something out there may already be sitting on, and nothing typed
 * into a label may move it. A step added in this session has no such history,
 * and its key is simply the spelling of its label until the day it is saved.
 */
export function nextStepName(
  { storedName, nextLabel, keyIsPersisted }: { storedName: string; nextLabel: string; keyIsPersisted: boolean },
): string {
  return keyIsPersisted && storedName !== '' ? storedName : deriveStepName(nextLabel);
}
