import { describe, it, expect } from 'vitest';
import {
  getActiveStepItems,
  decideGatekeeperAuthorization,
  findItemAcrossProjects,
  detectCrossProjectItem,
  INACTIVE_STATUSES,
  type GatekeeperFlow,
  type GatekeeperItem,
} from '../gatekeeper';

const item = (id: string, status: string, type = 'TASK', title?: string): GatekeeperItem => ({
  id,
  status,
  type,
  title: title ?? `t-${id}`,
});

const tddFlow: GatekeeperFlow = {
  steps: [
    { name: 'TODO', order: 0, isAnchor: true },
    { name: 'DISCOVERY', order: 1 },
    { name: 'CREATE_UNIT_TESTS', order: 2 },
    { name: 'IN_PROGRESS', order: 3 },
    { name: 'REVIEW', order: 4 },
    { name: 'DONE', order: 5, isAnchor: true },
  ],
};

describe('getActiveStepItems (moved to core)', () => {
  it('treats any non-anchor working step as active — including custom TDD steps', () => {
    const items = [
      item('a', 'DISCOVERY'),
      item('b', 'CREATE_UNIT_TESTS'),
      item('c', 'IN_PROGRESS'),
      item('d', 'REVIEW'),
      item('e', 'TODO'),
      item('f', 'DONE'),
    ];
    expect(getActiveStepItems(items, tddFlow).map(i => i.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('excludes anchors and inactive statuses', () => {
    const items = [item('1', 'TODO'), item('2', 'BLOCKED'), item('3', 'IN_PROGRESS'), item('4', 'DONE')];
    expect(getActiveStepItems(items, tddFlow).map(i => i.id)).toEqual(['3']);
  });
});

describe('decideGatekeeperAuthorization', () => {
  it('AUTHORIZES a TASK in a custom coding step (the bug-fix scenario)', () => {
    // This is the exact case the old CLI command wrongly rejected:
    // a TASK sitting in CREATE_UNIT_TESTS (not literal IN_PROGRESS).
    const items = [item('t1', 'CREATE_UNIT_TESTS')];
    const d = decideGatekeeperAuthorization(items, tddFlow, { intent: 'write tests' });
    expect(d.authorized).toBe(true);
    expect(d.task?.id).toBe('t1');
    expect(d.message).toContain('AUTHORIZED');
    expect(d.message).toContain('CREATE_UNIT_TESTS');
  });

  it('authorizes a BUG in an active step too', () => {
    const d = decideGatekeeperAuthorization([item('b1', 'DISCOVERY', 'BUG')], tddFlow, {});
    expect(d.authorized).toBe(true);
    expect(d.task?.id).toBe('b1');
  });

  it('is flow-aware for arbitrary role names (role is advisory, not a status gate)', () => {
    const d = decideGatekeeperAuthorization([item('t1', 'REVIEW')], tddFlow, { role: 'review' });
    expect(d.authorized).toBe(true);
    expect(d.message).toContain('REVIEW');
  });

  it('reports a breach when no TASK/BUG is in an active step', () => {
    const items = [item('t1', 'TODO'), item('t2', 'DONE')];
    const d = decideGatekeeperAuthorization(items, tddFlow, {});
    expect(d.authorized).toBe(false);
    expect(d.task).toBeNull();
    expect(d.message).toContain('WORKFLOW BREACH');
  });

  it('still hints to create a child item when only an EPIC is active', () => {
    // CGLAB-110: a lone STORY is directly actionable, so this refusal now only
    // fires for an EPIC — and the advice must name the child types.
    const d = decideGatekeeperAuthorization([item('e1', 'IN_PROGRESS', 'EPIC', 'My Epic')], tddFlow, {});
    expect(d.authorized).toBe(false);
    expect(d.message).toContain('My Epic');
    expect(d.message).toMatch(/STORY, TASK or BUG/);
  });

  it('is AMBIGUOUS when multiple tasks are active and no item id is given', () => {
    const items = [item('t1', 'IN_PROGRESS'), item('t2', 'CREATE_UNIT_TESTS')];
    const d = decideGatekeeperAuthorization(items, tddFlow, {});
    expect(d.authorized).toBe(false);
    expect(d.ambiguous).toBe(true);
    expect(d.message).toContain('t1'.substring(0, 8));
    expect(d.message).toContain('AMBIGUOUS');
  });

  it('resolves a specific item by id (full or prefix) when multiple are active', () => {
    const items = [item('aaaaaaaa-1', 'IN_PROGRESS'), item('bbbbbbbb-2', 'CREATE_UNIT_TESTS')];
    const d = decideGatekeeperAuthorization(items, tddFlow, { itemId: 'bbbbbbbb' });
    expect(d.authorized).toBe(true);
    expect(d.task?.id).toBe('bbbbbbbb-2');
  });

  it('rejects an item id that is not in an active step', () => {
    const items = [item('t1', 'IN_PROGRESS'), item('t2', 'DONE')];
    const d = decideGatekeeperAuthorization(items, tddFlow, { itemId: 't2' });
    expect(d.authorized).toBe(false);
    expect(d.message).toContain('t2');
  });

  it('refuses to authorize work directly on an EPIC even when targeted by id', () => {
    // CGLAB-110: only EPICs refuse direct work. A STORY targeted by id is
    // authorized — pinned in the CGLAB-110 block below.
    const d = decideGatekeeperAuthorization([item('e1', 'IN_PROGRESS', 'EPIC', 'Epic X')], tddFlow, { itemId: 'e1' });
    expect(d.authorized).toBe(false);
    expect(d.message).toContain('EPIC');
  });
});

// ── CGLAB-110: a STORY is directly actionable; only an EPIC refuses ──────────
// The shipped Standard Mode protocol decomposes EPICs into stories but says
// "Decomposing a story into tasks is not mandatory ... A small story goes
// straight to its first working step." The gatekeeper nonetheless deadlocked
// every STORY with a WORKFLOW BREACH (observed 2026-08-28 on CGLAB-109),
// forcing the decomposition the protocol waived. Fix: STORY joins the
// actionable set; EPIC alone still refuses direct authorization.
describe('a STORY is directly actionable, only an EPIC refuses (CGLAB-110)', () => {
  it('authorizes a STORY in an active step when targeted by id', () => {
    const d = decideGatekeeperAuthorization([item('s1', 'IN_PROGRESS', 'STORY', 'My Story')], tddFlow, { itemId: 's1' });
    expect(d.authorized).toBe(true);
    expect(d.task?.id).toBe('s1');
    expect(d.message).toContain('AUTHORIZED');
  });

  it('authorizes a STORY in a custom coding step (the observed CGLAB-109 deadlock)', () => {
    const d = decideGatekeeperAuthorization([item('a1f428b9', 'CREATE_UNIT_TESTS', 'STORY')], tddFlow, { itemId: 'a1f428b9' });
    expect(d.authorized).toBe(true);
    expect(d.task?.id).toBe('a1f428b9');
    expect(d.message).toContain('CREATE_UNIT_TESTS');
  });

  it('picks up a lone STORY as the actionable item when no TASK/BUG is active', () => {
    const d = decideGatekeeperAuthorization([item('s1', 'IN_PROGRESS', 'STORY', 'My Story')], tddFlow, {});
    expect(d.authorized).toBe(true);
    expect(d.task?.id).toBe('s1');
  });

  it('resolves a STORY by id prefix when a TASK is also active', () => {
    const items = [item('t1', 'IN_PROGRESS'), item('bbbbbbbb-2', 'CREATE_UNIT_TESTS', 'STORY', 'Story S')];
    const d = decideGatekeeperAuthorization(items, tddFlow, { itemId: 'bbbbbbbb' });
    expect(d.authorized).toBe(true);
    expect(d.task?.id).toBe('bbbbbbbb-2');
  });

  it('lists a STORY among the ambiguous active items', () => {
    const items = [item('t1', 'IN_PROGRESS'), item('s1', 'CREATE_UNIT_TESTS', 'STORY', 'Story S')];
    const d = decideGatekeeperAuthorization(items, tddFlow, {});
    expect(d.authorized).toBe(false);
    expect(d.ambiguous).toBe(true);
    expect(d.message).toContain('Story S');
  });

  it('still refuses when only an EPIC is active', () => {
    const d = decideGatekeeperAuthorization([item('e1', 'IN_PROGRESS', 'EPIC', 'Epic X')], tddFlow, {});
    expect(d.authorized).toBe(false);
    expect(d.message).toMatch(/WORKFLOW BREACH/);
    expect(d.message).toContain('Epic X');
  });

  it('carries the step contract onto an authorized STORY, not a refused EPIC', () => {
    const ok = decideGatekeeperAuthorization([item('s1', 'DISCOVERY', 'STORY')], criteriaFlow, { itemId: 's1' });
    expect(ok.authorized).toBe(true);
    expect(ok.exitCriteria).toBe('Cards created and the user gave the go-ahead.');
    const no = decideGatekeeperAuthorization([item('e1', 'DISCOVERY', 'EPIC')], criteriaFlow, { itemId: 'e1' });
    expect(no.authorized).toBe(false);
    expect(no.exitCriteria).toBeUndefined();
  });
});

describe('findItemAcrossProjects', () => {
  const items = [
    { id: 'aaaaaaaa-1111', projectId: 'projA', title: 'A' },
    { id: 'bbbbbbbb-2222', projectId: 'projB', title: 'B' },
  ];

  it('finds an item by full id regardless of project', () => {
    expect(findItemAcrossProjects(items, 'bbbbbbbb-2222')?.projectId).toBe('projB');
  });

  it('finds an item by id prefix', () => {
    expect(findItemAcrossProjects(items, 'aaaaaaaa')?.projectId).toBe('projA');
  });

  it('returns null when nothing matches', () => {
    expect(findItemAcrossProjects(items, 'zzzz')).toBeNull();
  });

  it('returns null for empty/blank id', () => {
    expect(findItemAcrossProjects(items, '')).toBeNull();
  });

  it('prefers an EXACT id match over a prefix match', () => {
    const colliding = [
      { id: 'abc-prefix-first', projectId: 'projA' },
      { id: 'abc', projectId: 'projB' }, // exact match, listed second
    ];
    expect(findItemAcrossProjects(colliding, 'abc')?.projectId).toBe('projB');
  });
});

describe('detectCrossProjectItem (B1: prefer in-project, avoid prefix-collision false positives)', () => {
  it('returns null when an in-project item matches — even if another project shares the prefix', () => {
    const all = [
      { id: 'bbbb1111-9999', projectId: 'projX', title: 'X-item' }, // other project, same prefix, listed first
      { id: 'bbbb1111-0000', projectId: 'projY', title: 'Y-item' }, // the cwd project's legit item
    ];
    // cwd = projY; prefix 'bbbb1111' collides, but Y has a match → NOT cross-project
    expect(detectCrossProjectItem(all, 'bbbb1111', 'projY')).toBeNull();
  });

  it('returns the other-project item only when no in-project match exists', () => {
    const all = [
      { id: 'cccc2222-1111', projectId: 'projX', title: 'X-only' },
      { id: 'dddd3333-1111', projectId: 'projY', title: 'Y-other' },
    ];
    const r = detectCrossProjectItem(all, 'cccc2222', 'projY');
    expect(r?.projectId).toBe('projX');
  });

  it('returns null when the match is already in the current project', () => {
    const all = [{ id: 'eeee4444', projectId: 'projY', title: 'mine' }];
    expect(detectCrossProjectItem(all, 'eeee4444', 'projY')).toBeNull();
  });

  it('returns null without an item id or current project', () => {
    const all = [{ id: 'x', projectId: 'projX' }];
    expect(detectCrossProjectItem(all, undefined, 'projY')).toBeNull();
    expect(detectCrossProjectItem(all, 'x', undefined)).toBeNull();
  });
});

// ── CGLAB-83: the CLI must learn what the MCP tool already knew ──────────────
// The gatekeeper receives the flow, so it can report the current step's exit
// criteria and the flow's shape. It used to discard both, which forced every
// shipped command to tell CLI-only agents to go fetch the criteria from a second
// command — a documented workaround for a capability gap.

const criteriaFlow: GatekeeperFlow = {
  name: 'TDD Flow',
  steps: [
    { name: 'TODO', order: 0, isAnchor: true },
    { name: 'DISCOVERY', order: 1, exitCriteria: 'Cards created and the user gave the go-ahead.' },
    { name: 'CREATE_UNIT_TESTS', order: 2, exitCriteria: 'All tests written; they may fail.' },
    { name: 'IN_PROGRESS', order: 3 },
    { name: 'DONE', order: 4, isAnchor: true },
  ],
} as GatekeeperFlow;

describe('decideGatekeeperAuthorization surfaces the step contract (CGLAB-83)', () => {
  it('returns the current step exit criteria as a structured field', () => {
    const d = decideGatekeeperAuthorization([item('a', 'CREATE_UNIT_TESTS')], criteriaFlow, {});
    expect(d.authorized).toBe(true);
    expect(d.exitCriteria).toBe('All tests written; they may fail.');
  });

  it('puts the exit criteria in the message so a CLI-only agent sees them', () => {
    const d = decideGatekeeperAuthorization([item('a', 'DISCOVERY')], criteriaFlow, {});
    expect(d.message).toContain('Cards created and the user gave the go-ahead.');
  });

  it('reports the criteria of the step the item is ON, not another step', () => {
    const d = decideGatekeeperAuthorization([item('a', 'DISCOVERY')], criteriaFlow, {});
    expect(d.exitCriteria).toBe('Cards created and the user gave the go-ahead.');
    expect(d.message).not.toContain('All tests written');
  });

  it('says explicitly that a step defines no criteria, instead of staying silent', () => {
    // The shipped default flow defines no criteria at all (CGLAB-82), so silence
    // here would read as "nothing is required".
    const d = decideGatekeeperAuthorization([item('a', 'IN_PROGRESS')], criteriaFlow, {});
    expect(d.exitCriteria).toBeUndefined();
    expect(d.message).toMatch(/no exit criteria/i);
  });

  it('reports the active flow name and its real step names, not the defaults', () => {
    const d = decideGatekeeperAuthorization([item('a', 'IN_PROGRESS')], criteriaFlow, {});
    expect(d.activeFlow?.name).toBe('TDD Flow');
    expect(d.activeFlow?.steps).toEqual(['TODO', 'DISCOVERY', 'CREATE_UNIT_TESTS', 'IN_PROGRESS', 'DONE']);
    expect(d.message).toContain('CREATE_UNIT_TESTS');
  });

  it('names agenfk verify as the way to advance, never update --status', () => {
    const d = decideGatekeeperAuthorization([item('a', 'DISCOVERY')], criteriaFlow, {});
    expect(d.message).toContain('agenfk verify');
    expect(d.message).not.toMatch(/update\s+--status/);
  });

  it('matches the step case-insensitively, as the server does', () => {
    const d = decideGatekeeperAuthorization([item('a', 'discovery')], criteriaFlow, {});
    expect(d.exitCriteria).toBe('Cards created and the user gave the go-ahead.');
  });

  it('carries no step contract when authorization is refused', () => {
    const d = decideGatekeeperAuthorization([item('a', 'TODO')], criteriaFlow, {});
    expect(d.authorized).toBe(false);
    expect(d.exitCriteria).toBeUndefined();
  });
});

// ── Review findings F1 / F6 ─────────────────────────────────────────────────
// F1: "no exit criteria" was asserted for three different situations, only one
// of which actually means the step defines none. Claiming a bar does not exist
// when it merely could not be looked up is worse than saying nothing.
// F6: the loop tells agents to identify the coding step and the final step from
// what the gatekeeper reports, but a bare string[] of names cannot be used for
// that without re-hardcoding TODO/DONE — the exact thing this refactor kills.

const anchoredFlow: GatekeeperFlow = {
  name: 'TDD Flow',
  steps: [
    { name: 'TODO', order: 0, isAnchor: true },
    { name: 'DISCOVERY', order: 1, exitCriteria: 'Cards created.' },
    { name: 'IN_PROGRESS', order: 2 },
    { name: 'DONE', order: 3, isAnchor: true },
  ],
} as GatekeeperFlow;

describe('the gatekeeper distinguishes unknown criteria from absent criteria (F1)', () => {
  it('says criteria are UNKNOWN, not absent, when the flow could not be resolved', () => {
    const d = decideGatekeeperAuthorization([item('a', 'IN_PROGRESS')], null as any, {});
    expect(d.authorized).toBe(true);
    expect(d.criteriaState).toBe('flow-unresolved');
    expect(d.message).toMatch(/unknown/i);
    expect(d.message).not.toMatch(/defines no exit criteria/i);
  });

  it('treats an empty step list as unresolved rather than as "no criteria"', () => {
    const d = decideGatekeeperAuthorization([item('a', 'IN_PROGRESS')], { steps: [] }, {});
    expect(d.criteriaState).toBe('flow-unresolved');
    expect(d.message).not.toMatch(/defines no exit criteria/i);
  });

  it('flags a status that is not a step of the active flow instead of inventing a verdict', () => {
    // Reachable: `agenfk flow use` can switch a project's flow under an item
    // that is sitting on a step the new flow does not contain.
    const d = decideGatekeeperAuthorization([item('a', 'TEST')], anchoredFlow, {});
    expect(d.criteriaState).toBe('status-not-in-flow');
    expect(d.message).toMatch(/not a step of the active flow/i);
    expect(d.message).not.toMatch(/defines no exit criteria/i);
  });

  it('only says a step defines no criteria when the step really is in the flow', () => {
    const d = decideGatekeeperAuthorization([item('a', 'IN_PROGRESS')], anchoredFlow, {});
    expect(d.criteriaState).toBe('none-defined');
    expect(d.message).toMatch(/defines no exit criteria/i);
  });

  it('reports criteriaState "present" when the step has criteria', () => {
    const d = decideGatekeeperAuthorization([item('a', 'DISCOVERY')], anchoredFlow, {});
    expect(d.criteriaState).toBe('present');
    expect(d.exitCriteria).toBe('Cards created.');
  });
});

describe('the gatekeeper resolves the coding and final steps itself (F6)', () => {
  it('names the coding step as the first non-anchor step', () => {
    const d = decideGatekeeperAuthorization([item('a', 'IN_PROGRESS')], anchoredFlow, {});
    expect(d.codingStep).toBe('DISCOVERY');
  });

  it('names the final step as the last step before the DONE anchor', () => {
    const d = decideGatekeeperAuthorization([item('a', 'IN_PROGRESS')], anchoredFlow, {});
    expect(d.finalStep).toBe('IN_PROGRESS');
  });

  it('treats the last step as final when the flow has no DONE anchor', () => {
    // POST /flows does not require anchors, so an anchorless flow is real. The
    // server's rule is "the step with no successor", not "the step before DONE".
    const anchorless: GatekeeperFlow = {
      name: 'Lean',
      steps: [{ name: 'BUILD', order: 0 }, { name: 'SHIP', order: 1 }],
    } as GatekeeperFlow;
    const d = decideGatekeeperAuthorization([item('a', 'BUILD')], anchorless, {});
    expect(d.finalStep).toBe('SHIP');
    expect(d.codingStep).toBe('BUILD');
  });

  it('puts the coding and final steps in the message so no derivation is needed', () => {
    const d = decideGatekeeperAuthorization([item('a', 'IN_PROGRESS')], anchoredFlow, {});
    expect(d.message).toMatch(/coding step/i);
    expect(d.message).toMatch(/final step/i);
  });

  it('leaks no step contract at all onto a refused authorization', () => {
    // Strengthened per F8: the original guard checked only exitCriteria.
    const d = decideGatekeeperAuthorization([item('a', 'TODO')], anchoredFlow, {});
    expect(d.authorized).toBe(false);
    expect(d.exitCriteria).toBeUndefined();
    expect(d.activeFlow).toBeUndefined();
    expect(d.codingStep).toBeUndefined();
    expect(d.finalStep).toBeUndefined();
    expect(d.criteriaState).toBeUndefined();
    expect(d.message).not.toContain('Cards created.');
  });
});

// ── CGLAB-82: the shipped default flow must state what each step wants ──────
// DEFAULT_STEPS defined no exitCriteria at all, so on a default install every
// criteria-driven instruction in the framework evaluated to nothing. That is
// why the de-prescribed work loop needed position-based fallbacks.
describe('the shipped default flow states its exit criteria (CGLAB-82)', () => {
  it('reports real criteria for the coding step rather than the no-criteria fallback', async () => {
    const { DEFAULT_FLOW } = await import('../defaultFlow');
    const d = decideGatekeeperAuthorization(
      [item('a', 'IN_PROGRESS')],
      DEFAULT_FLOW as unknown as GatekeeperFlow,
      {},
    );
    expect(d.criteriaState).toBe('present');
    expect(d.exitCriteria).toBeTruthy();
    expect(d.message).not.toMatch(/defines no exit criteria/i);
  });

  it('gives every non-anchor default step criteria, so no step is silent', async () => {
    const { DEFAULT_FLOW } = await import('../defaultFlow');
    const working = DEFAULT_FLOW.steps.filter((s: any) => !s.isAnchor);
    expect(working.length).toBeGreaterThan(0);
    for (const step of working) {
      const d = decideGatekeeperAuthorization(
        [item('a', step.name)],
        DEFAULT_FLOW as unknown as GatekeeperFlow,
        {},
      );
      expect(d.criteriaState, `${step.name} has no criteria`).toBe('present');
    }
  });

  it('leaves the anchors alone — TODO and DONE are not worked steps', async () => {
    const { DEFAULT_FLOW } = await import('../defaultFlow');
    const anchors = DEFAULT_FLOW.steps.filter((s: any) => s.isAnchor);
    for (const a of anchors) expect((a as any).exitCriteria ?? '').toBe('');
  });
});

// ── Mutation hardening (CGLAB-110 MUTATION_TESTS step) ──────────────────────
// StrykerJS over packages/core/src/gatekeeper.ts reported 44 surviving mutants
// against the original suite. These tests pin the behaviours those mutants
// slipped through: the inactive-status set and its null-flow anchor fallback,
// the cross-project match's projectId requirement, order-field sorting, the
// whitespace-only criteria trim, and the exact refusal/fallback message copy.
describe('mutation hardening for the gatekeeper (CGLAB-110)', () => {
  it('excludes every INACTIVE_STATUSES entry, each name individually', () => {
    for (const status of ['BLOCKED', 'PAUSED', 'TRASHED', 'ARCHIVED', 'IDEAS']) {
      expect(INACTIVE_STATUSES).toContain(status);
      const d = decideGatekeeperAuthorization([item('a', status)], tddFlow, {});
      expect(d.authorized, `${status} must never be an active working step`).toBe(false);
    }
  });

  it('falls back to TODO/DONE anchors when the flow is null', () => {
    const items = [item('a', 'TODO'), item('b', 'DONE'), item('c', 'IN_PROGRESS')];
    const active = getActiveStepItems(items, null);
    expect(active.map(i => i.id)).toEqual(['c']);
  });

  it('never treats a cross-project match lacking a projectId as the match', () => {
    const all = [
      { id: 'ffff0000-1111', title: 'no-project match' } as any, // projectId undefined
    ];
    expect(detectCrossProjectItem(all, 'ffff0000', 'projC')).toBeNull();
  });

  it('prefers an in-project PREFIX-only match over an out-of-project exact match', () => {
    // Kills the inner ||→&& mutant: the original accepts the in-project item on
    // the id-prefix alone, so it must short-circuit the cross-project return.
    const all = [
      { id: 'abcdef12-other', projectId: 'projX', title: 'other' },
      { id: 'abcdef12-mine', projectId: 'projY', title: 'mine' },
    ];
    expect(detectCrossProjectItem(all, 'abcdef12', 'projY')).toBeNull();
  });

  it('resolves coding/final steps by the order field, not array position', () => {
    const shuffled: GatekeeperFlow = {
      name: 'Shuffled',
      steps: [
        { name: 'IN_PROGRESS', order: 2 },
        { name: 'DONE', order: 3, isAnchor: true },
        { name: 'DISCOVERY', order: 1 },
        { name: 'TODO', order: 0, isAnchor: true },
      ],
    } as GatekeeperFlow;
    const d = decideGatekeeperAuthorization([item('a', 'IN_PROGRESS')], shuffled, {});
    expect(d.codingStep).toBe('DISCOVERY');
    expect(d.finalStep).toBe('IN_PROGRESS');
  });

  it('survives a flow whose every step is an anchor (no coding step, no throw)', () => {
    const anchorsOnly: GatekeeperFlow = {
      name: 'Anchors',
      steps: [
        { name: 'TODO', order: 0, isAnchor: true },
        { name: 'DONE', order: 1, isAnchor: true },
      ],
    } as GatekeeperFlow;
    const d = decideGatekeeperAuthorization([item('a', 'IN_PROGRESS')], anchorsOnly, {});
    expect(d.authorized).toBe(true);
    expect(d.codingStep).toBeUndefined();
    // Degenerate flow with no working steps: only DONE is filtered out of the
    // "non-terminal" set, so the leftover anchor (TODO) is what finalStep pins.
    expect(d.finalStep).toBe('TODO');
  });

  it('treats whitespace-only exit criteria as none-defined', () => {
    const wsFlow: GatekeeperFlow = {
      steps: [
        { name: 'TODO', order: 0, isAnchor: true },
        { name: 'IN_PROGRESS', order: 1, exitCriteria: '   ' },
        { name: 'DONE', order: 2, isAnchor: true },
      ],
    } as GatekeeperFlow;
    const d = decideGatekeeperAuthorization([item('a', 'IN_PROGRESS')], wsFlow, {});
    expect(d.criteriaState).toBe('none-defined');
    expect(d.exitCriteria).toBeUndefined();
  });

  it('says "Could not resolve this project\'s flow" when the flow is unresolved', () => {
    const d = decideGatekeeperAuthorization([item('a', 'IN_PROGRESS')], null as any, {});
    expect(d.message).toContain("Could not resolve this project's flow");
  });

  it('joins the active flow steps with the arrow separator', () => {
    const d = decideGatekeeperAuthorization([item('a', 'IN_PROGRESS')], anchoredFlow, {});
    expect(d.message).toContain('TODO → DISCOVERY → IN_PROGRESS → DONE');
    expect(d.message).toContain('Final step (omit the command on this one): IN_PROGRESS');
  });

  it('renders a nameless flow without a quoted name', () => {
    const d = decideGatekeeperAuthorization([item('a', 'IN_PROGRESS')], anchoredFlow, {});
    expect(d.message).toContain('Active flow "TDD Flow"');
    const anonymous = { steps: anchoredFlow.steps } as GatekeeperFlow;
    const d2 = decideGatekeeperAuthorization([item('a', 'IN_PROGRESS')], anonymous, {});
    expect(d2.message).toContain('Active flow: TODO → DISCOVERY → IN_PROGRESS → DONE');
    expect(d2.message).not.toContain('Active flow ""');
  });

  it('echoes the no-intent fallback and the default role in the message', () => {
    const d = decideGatekeeperAuthorization([item('a', 'IN_PROGRESS')], tddFlow, {});
    expect(d.message).toContain('Intent: "(no intent provided)"');
    expect(d.message).toContain('AUTHORIZED (CODING)');
  });

  it('pins the generic no-actionable refusal copy', () => {
    const d = decideGatekeeperAuthorization([item('a', 'TODO')], tddFlow, {});
    expect(d.message).toContain('No STORY, TASK or BUG is in an active working step');
    expect(d.message).toContain('Create or advance a STORY, TASK or BUG to an active step first');
  });

  it('pins the EPIC refusal copy when a STORY is also actionable', () => {
    // The by-id refusal branch only runs when SOME actionable item exists —
    // with an EPIC as the sole active item the no-actionable refusal fires first.
    const items = [item('s1', 'IN_PROGRESS', 'STORY'), item('e1', 'IN_PROGRESS', 'EPIC', 'Epic X')];
    const d = decideGatekeeperAuthorization(items, tddFlow, { itemId: 'e1' });
    expect(d.authorized).toBe(false);
    expect(d.message).toContain('Cannot authorize work directly on an EPIC [e1] "Epic X"');
    expect(d.message).toContain('An EPIC is never worked directly — create or advance a STORY, TASK or BUG within it');
  });

  it('pins the EPIC-stuck hint copy', () => {
    const d = decideGatekeeperAuthorization([item('e1', 'IN_PROGRESS', 'EPIC', 'My Epic')], tddFlow, {});
    expect(d.message).toContain('"My Epic" (EPIC) is at step IN_PROGRESS, but an EPIC is never worked directly');
  });

  it('embeds the 8-char id prefix, not the full id, in the EPIC refusal', () => {
    const longId = 'a1b2c3d4-ef56-abcd-ef01-23456789abcd';
    const items = [item('s1', 'IN_PROGRESS', 'STORY'), { ...item(longId, 'IN_PROGRESS', 'EPIC', 'Long Epic') }];
    const d = decideGatekeeperAuthorization(items, tddFlow, { itemId: 'a1b2c3d4-ef56' });
    expect(d.authorized).toBe(false);
    expect(d.message).toContain('EPIC [a1b2c3d4] "Long Epic"');
  });

  it('pins the ambiguity listing line format', () => {
    const items = [item('aaaaaaaa-1', 'IN_PROGRESS'), item('bbbbbbbb-2', 'CREATE_UNIT_TESTS', 'STORY', 'Story S')];
    const d = decideGatekeeperAuthorization(items, tddFlow, {});
    expect(d.message).toContain('Multiple items are in an active step. Provide --item-id to disambiguate');
    expect(d.message).toContain('• [aaaaaaaa] t-aaaaaaaa-1 (IN_PROGRESS)');
    expect(d.message).toContain('• [bbbbbbbb] Story S (CREATE_UNIT_TESTS)');
    // The listing is newline-separated — pin the separator itself.
    expect(d.message).toContain('(IN_PROGRESS)\n  • [bbbbbbbb] Story S');
  });

  it('pins the exact coding-step and final-step lines, and omits the coding line when there is none', () => {
    const d = decideGatekeeperAuthorization([item('a', 'IN_PROGRESS')], anchoredFlow, {});
    expect(d.message).toContain('Coding step: DISCOVERY\nFinal step (omit the command on this one): IN_PROGRESS');
    const anchorsOnly: GatekeeperFlow = {
      steps: [
        { name: 'TODO', order: 0, isAnchor: true },
        { name: 'DONE', order: 1, isAnchor: true },
      ],
    } as GatekeeperFlow;
    const d2 = decideGatekeeperAuthorization([item('a', 'IN_PROGRESS')], anchorsOnly, {});
    expect(d2.message).not.toContain('Coding step:');
    // Exact adjacency: with no coding step, the final-step line follows the
    // flow line directly — nothing may be injected in between.
    expect(d2.message).toContain('Active flow: TODO → DONE\nFinal step (omit the command on this one): TODO');
  });

  it('leaks no step-shape copy when the flow could not be resolved', () => {
    const d = decideGatekeeperAuthorization([item('a', 'IN_PROGRESS')], null as any, {});
    expect(d.message).not.toContain('Active flow');
    expect(d.message).not.toContain('Coding step');
    // With no flow there is no step-shape block at all: the message must end
    // exactly where the advice ends — nothing appended after it.
    expect(d.message).toMatch(/before advancing\.$/);
  });

  it('embeds the item id prefix in the advance hint', () => {
    const d = decideGatekeeperAuthorization([item('a1b2c3d4-9999', 'IN_PROGRESS')], tddFlow, {});
    expect(d.message).toContain('agenfk verify a1b2c3d4 --evidence');
  });

  it('embeds the step status and title in the authorized message', () => {
    const d = decideGatekeeperAuthorization([item('a1b2c3d4-9999', 'IN_PROGRESS', 'STORY', 'My Story')], tddFlow, {});
    expect(d.message).toContain('STORY: [a1b2c3d4] My Story');
    expect(d.message).toContain('Current step: IN_PROGRESS');
  });
});
