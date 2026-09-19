/**
 * BUG 269eeec8 defect (c) — the Hub validates flow-definition shape
 * (packages/hub/src/routes/admin.ts validateDefinition) while the local agenfk
 * server validated nothing, so the same editor could author a flow the local
 * server persisted happily and the Hub rejected with a bare 400. This mirrors
 * the Hub's contract client-side so Save is blocked with a field-level reason
 * before any request goes out.
 *
 * These assertions ARE the contract: if the Hub's validator gains a rule, it
 * gains a case here too, or the editor silently drifts back out of sync.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { flowDefinitionIssues, withStepIds, deriveStepName, nextStepName } from '../flowDefinition';
import type { FlowStep } from '../types';

const step = (over: Partial<FlowStep> = {}): FlowStep => ({
  id: 's1',
  name: 'work',
  label: 'Work',
  order: 1,
  exitCriteria: '',
  ...over,
});

const validSteps = (): FlowStep[] => [
  step({ id: 's0', name: 'TODO', label: 'To Do', order: 0, isAnchor: true }),
  step({ id: 's1', name: 'work', label: 'Work', order: 1 }),
  step({ id: 's2', name: 'DONE', label: 'Done', order: 2, isAnchor: true }),
];

describe('flowDefinitionIssues', () => {
  it('reports nothing for a well-formed definition', () => {
    expect(flowDefinitionIssues('My Flow', validSteps())).toEqual([]);
  });

  it('rejects a blank flow name', () => {
    const issues = flowDefinitionIssues('   ', validSteps());
    expect(issues).toHaveLength(1);
    expect(issues[0].stepIndex).toBeUndefined();
    expect(issues[0].message).toMatch(/name/i);
  });

  it('rejects an empty step list', () => {
    expect(flowDefinitionIssues('My Flow', [])).toHaveLength(1);
  });

  // The defect that actually fired: makeBlankStep() seeds `name: ''`, so adding
  // a step and saving before typing a name 400s the whole save at the Hub.
  it('pins the blank step name to the offending step index', () => {
    const steps = validSteps();
    steps.splice(2, 0, step({ id: 'new', name: '', label: '', order: 2 }));
    const issues = flowDefinitionIssues('My Flow', steps);
    expect(issues).toHaveLength(1);
    expect(issues[0].stepIndex).toBe(2);
    expect(issues[0].message).toMatch(/name/i);
  });

  it('treats a whitespace-only step name as blank', () => {
    const steps = validSteps();
    steps[1] = step({ id: 's1', name: '  ', label: 'Work', order: 1 });
    expect(flowDefinitionIssues('My Flow', steps)[0].stepIndex).toBe(1);
  });

  it('reports every blank step, not just the first', () => {
    const steps = validSteps();
    steps.splice(1, 0, step({ id: 'n1', name: '', order: 1 }));
    steps.splice(3, 0, step({ id: 'n2', name: '', order: 3 }));
    const issues = flowDefinitionIssues('My Flow', steps);
    expect(issues.map(i => i.stepIndex)).toEqual([1, 3]);
  });

  // Deliberately NOT gated: MCP create_flow never sent step ids (its schema
  // omitted the key), so flows already in users' databases have steps — anchors
  // included — without one. Blocking Save would strand the user in front of a
  // field the editor does not expose, with anchors offering no input at all.
  it('does NOT block on a missing step id — it is backfilled, not user-fixable', () => {
    const steps = validSteps();
    steps[1] = step({ id: '', name: 'work', order: 1 });
    expect(flowDefinitionIssues('My Flow', steps)).toEqual([]);
  });

  // Also not gated: the save payload rewrites order to the array index, so a
  // bad value in loaded data is repaired by the request itself.
  it('does NOT block on a non-numeric step order — the payload rewrites it', () => {
    const steps = validSteps();
    steps[1] = { ...step({ id: 's1', name: 'work' }), order: undefined as unknown as number };
    expect(flowDefinitionIssues('My Flow', steps)).toEqual([]);
  });

  it('accumulates a flow-level and a step-level issue together', () => {
    const steps = validSteps();
    steps[1] = step({ id: 's1', name: '', order: 1 });
    const issues = flowDefinitionIssues('', steps);
    expect(issues).toHaveLength(2);
    expect(issues.some(i => i.stepIndex === undefined)).toBe(true);
    expect(issues.some(i => i.stepIndex === 1)).toBe(true);
  });
});

describe('withStepIds', () => {
  let n = 0;
  const gen = () => `generated-${++n}`;
  beforeEach(() => { n = 0; });

  it('fills in ids for steps that lack them and leaves existing ids alone', () => {
    const steps = [step({ id: 'keep', name: 'a', order: 0 }), step({ id: '', name: 'b', order: 1 })];
    const out = withStepIds(steps, gen);
    expect(out[0].id).toBe('keep');
    expect(out[1].id).toBe('generated-1');
  });

  it('does not mutate the input array or its steps', () => {
    const steps = [step({ id: '', name: 'a', order: 0 })];
    const out = withStepIds(steps, gen);
    expect(steps[0].id).toBe('');
    expect(out[0]).not.toBe(steps[0]);
  });

  it('preserves every other field while filling the id', () => {
    const steps = [step({ id: '', name: 'a', label: 'A', order: 3, exitCriteria: 'done when X' })];
    const [out] = withStepIds(steps, gen);
    expect(out).toMatchObject({ name: 'a', label: 'A', order: 3, exitCriteria: 'done when X' });
  });
});

// ── The step name is derived, not typed ────────────────────────────────────
// A flow row showed two bordered inputs: the key and the label. The artifact
// (aca414c7 §01) draws them as ONE cell — `VALIDATE` over a small `Validate` —
// and the read-only branch of the editor already rendered exactly that. The
// key was always derivable: every step of the flow this was reported against
// is its own label, uppercased with the punctuation turned into underscores.
describe('deriveStepName', () => {
  // Four of four, on the flow that was actually on screen. This is the
  // evidence that the rule is not being invented here — it is being restored.
  it.each([
    ['Plan (local)', 'PLAN_LOCAL'],
    ['Validate (local)', 'VALIDATE_LOCAL'],
    ['Review', 'REVIEW'],
    ['Docker (local)', 'DOCKER_LOCAL'],
  ])('derives %s to %s', (label, name) => {
    expect(deriveStepName(label)).toBe(name);
  });

  it('collapses a run of punctuation into one underscore', () => {
    // "CODE___REVIEW" is a different status string from "CODE_REVIEW", and a
    // person typing "Code -- review" means one separator, not three.
    expect(deriveStepName('Code -- review')).toBe('CODE_REVIEW');
  });

  it('does not leave an underscore at either end', () => {
    // A leading or trailing separator would be invisible in the UI and load-
    // bearing in `agenfk update --status`.
    expect(deriveStepName('  (review)  ')).toBe('REVIEW');
  });

  it('is empty for a label that carries no word characters', () => {
    // Not "___". An empty name is already refused by flowDefinitionIssues
    // with a message pinned to the step; a name of underscores would pass
    // that check and be unusable.
    expect(deriveStepName('!!!')).toBe('');
    expect(deriveStepName('')).toBe('');
  });

  it('keeps digits, because a step may be numbered', () => {
    expect(deriveStepName('Stage 2 review')).toBe('STAGE_2_REVIEW');
  });
});

// ── Renaming a step is not a cosmetic act ──────────────────────────────────
// The name IS the status: `agenfk update --status <name>` takes it, and items
// already sitting on that step answer to it. So the derivation may only
// overwrite a name that was still in sync with the label it came from. A name
// somebody set by hand is a decision, and editing the label must not silently
// undo it.
describe('nextStepName', () => {
  it('follows the label on a step still being written', () => {
    expect(nextStepName({ storedName: 'CODE', nextLabel: 'Code review', keyIsPersisted: false }))
      .toBe('CODE_REVIEW');
  });

  it('fills in a name that was never set', () => {
    expect(nextStepName({ storedName: '', nextLabel: 'Plan (local)', keyIsPersisted: false }))
      .toBe('PLAN_LOCAL');
  });

  it('LEAVES A SAVED KEY ALONE', () => {
    // APPLY_BLOCKED shown as "Never apply". Retitling the label must not move
    // every item off APPLY_BLOCKED.
    expect(nextStepName({ storedName: 'APPLY_BLOCKED', nextLabel: 'Never apply, ever', keyIsPersisted: true }))
      .toBe('APPLY_BLOCKED');
  });

  it('leaves a saved lower-case key alone', () => {
    // `in_review` is a status the server accepts as it stands; upcasing it on
    // the next keystroke would be a rename by another route.
    expect(nextStepName({ storedName: 'in_review', nextLabel: 'In review now', keyIsPersisted: true }))
      .toBe('in_review');
  });
});

// ── What the first round of review found ───────────────────────────────────
describe('deriveStepName, on labels that are not English', () => {
  // The language this was reported in. The tilde is not alphanumeric, so an
  // ASCII-only rule replaced the VOWEL IT SAT ON with a separator.
  it.each([
    ['Validação (local)', 'VALIDACAO_LOCAL'],
    ['Revisão', 'REVISAO'],
    ['Análise técnica', 'ANALISE_TECNICA'],
    ['Étape', 'ETAPE'],
  ])('folds the accent and keeps the letter: %s -> %s', (label, name) => {
    expect(deriveStepName(label)).toBe(name);
  });

  // Not the empty string. With no key field left, an empty derivation means
  // the flow cannot be authored at all — and hub-ui has no CLI to fall back to.
  it('keeps letters from a script that has no ASCII form', () => {
    expect(deriveStepName('Проверка')).toBe('ПРОВЕРКА');
    expect(deriveStepName('レビュー')).toBe('レビュー');
  });
});

describe('nextStepName, once a key has been saved', () => {
  // THE REGRESSION THIS REPLACED. Every key the default flow ships is its own
  // label derived — IN_PROGRESS over "In Progress" — so "still in sync" made
  // the common case the unprotected one. Retitling a step of a live flow
  // rewrote the status of every item sitting on it, and PUT /flows/:id does
  // not migrate them.
  it('never rewrites a persisted key, however in sync it looks', () => {
    expect(nextStepName({ storedName: 'REVIEW', nextLabel: 'Peer review', keyIsPersisted: true }))
      .toBe('REVIEW');
  });

  it('follows the label on a step that has never been saved', () => {
    expect(nextStepName({ storedName: 'RE', nextLabel: 'Rev', keyIsPersisted: false }))
      .toBe('REV');
  });

  it('fills a blank key even on a persisted step, because blank is not a status', () => {
    expect(nextStepName({ storedName: '', nextLabel: 'Plan (local)', keyIsPersisted: true }))
      .toBe('PLAN_LOCAL');
  });
});

describe('two steps cannot share a key', () => {
  const step = (name: string, order: number) => ({ id: `s${order}`, name, label: name, order, exitCriteria: '' });

  it('reports the SECOND of a colliding pair', () => {
    const issues = flowDefinitionIssues('F', [step('TODO', 0), step('REVIEW', 1), step('REVIEW', 2), step('DONE', 3)]);
    expect(issues).toHaveLength(1);
    expect(issues[0].stepIndex).toBe(2);
    expect(issues[0].message).toContain('repeats step 2');
  });

  it('catches a collision that differs only in case', () => {
    // "Review" and "review" derive to the same key and look like two steps.
    const issues = flowDefinitionIssues('F', [step('REVIEW', 0), step('review', 1)]);
    expect(issues.map(i => i.stepIndex)).toEqual([1]);
  });

  it('says nothing when every key is distinct', () => {
    expect(flowDefinitionIssues('F', [step('TODO', 0), step('REVIEW', 1), step('DONE', 2)])).toEqual([]);
  });
});
