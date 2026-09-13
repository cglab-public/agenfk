/**
 * @vitest-environment jsdom
 *
 * CGLAB-172: what counts as "in flight" for a project folder.
 *
 * The sidebar folder shows work that is actually moving — not the backlog, not
 * the archive. "In flight" is defined by the project's own flow rather than by
 * hardcoded status names, because a project can rename or reorder its steps and
 * a hardcoded list would quietly show the wrong thing on every custom flow.
 */
import { describe, it, expect } from 'vitest';
import { inFlightItems } from '../inFlight';
import type { Flow, AgEnFKItem } from '../types';

const flow = (names: string[], anchors: string[] = []): Flow => ({
  id: 'f1',
  name: 'test flow',
  steps: names.map((name, order) => ({
    id: `s${order}`, name, label: name, order,
    isAnchor: anchors.includes(name),
  })),
  createdAt: '', updatedAt: '',
});

const DEFAULT = flow(['TODO', 'IN_PROGRESS', 'REVIEW', 'DONE'], ['TODO', 'DONE']);

const item = (id: string, status: string, extra: Partial<AgEnFKItem> = {}): AgEnFKItem =>
  ({ id, projectId: 'p1', title: id, status, type: 'TASK', ...extra } as AgEnFKItem);

describe('inFlightItems', () => {
  it('keeps items sitting in a working step', () => {
    const items = [item('a', 'IN_PROGRESS'), item('b', 'REVIEW')];
    expect(inFlightItems(items, DEFAULT).map(i => i.id)).toEqual(['a', 'b']);
  });

  it('drops the backlog and the finished work — the anchors', () => {
    const items = [item('todo', 'TODO'), item('go', 'IN_PROGRESS'), item('done', 'DONE')];
    expect(inFlightItems(items, DEFAULT).map(i => i.id)).toEqual(['go']);
  });

  it('follows a custom flow rather than hardcoded status names', () => {
    // A TDD flow's working steps are not called IN_PROGRESS at all.
    const tdd = flow(['TODO', 'DISCOVERY', 'CREATE_UNIT_TESTS', 'DONE'], ['TODO', 'DONE']);
    const items = [item('a', 'DISCOVERY'), item('b', 'CREATE_UNIT_TESTS'), item('c', 'TODO')];
    expect(inFlightItems(items, tdd).map(i => i.id)).toEqual(['a', 'b']);
  });

  it('honours the deprecated isSpecial as an anchor marker', () => {
    // Older flows stored the anchor flag under a different name; treating
    // those steps as working would put the whole backlog in the folder.
    const legacy: Flow = {
      ...DEFAULT,
      steps: DEFAULT.steps.map(s => ({
        id: s.id, name: s.name, label: s.label, order: s.order,
        isSpecial: s.name === 'TODO' || s.name === 'DONE',
      })),
    };
    expect(inFlightItems([item('t', 'TODO'), item('p', 'IN_PROGRESS')], legacy).map(i => i.id))
      .toEqual(['p']);
  });

  it('excludes paused and blocked work — it is not moving', () => {
    const items = [item('p', 'PAUSED'), item('b', 'BLOCKED'), item('go', 'IN_PROGRESS')];
    expect(inFlightItems(items, DEFAULT).map(i => i.id)).toEqual(['go']);
  });

  it('excludes archived items — archiving here is a status, not a flag', () => {
    const items = [item('a', 'ARCHIVED'), item('b', 'IN_PROGRESS')];
    expect(inFlightItems(items, DEFAULT).map(i => i.id)).toEqual(['b']);
  });

  it('excludes an archived item even if a flow defines a step by that name', () => {
    // A flow is free to name a working step ARCHIVED; the item is still parked.
    const odd = flow(['TODO', 'ARCHIVED', 'DONE'], ['TODO', 'DONE']);
    expect(inFlightItems([item('a', 'ARCHIVED')], odd)).toEqual([]);
  });

  it('returns nothing rather than everything when the flow is missing', () => {
    // A flow still loading must not flash the entire backlog into the folder.
    expect(inFlightItems([item('a', 'IN_PROGRESS')], undefined)).toEqual([]);
  });

  it('returns nothing for an empty item list', () => {
    expect(inFlightItems([], DEFAULT)).toEqual([]);
  });

  it('does not mutate the array it was given', () => {
    const items = [item('a', 'IN_PROGRESS'), item('b', 'TODO')];
    const copy = [...items];
    inFlightItems(items, DEFAULT);
    expect(items).toEqual(copy);
  });

  it('tolerates an item whose status is not in the flow at all', () => {
    // Status left behind by a flow migration — show it nowhere rather than crash.
    expect(() => inFlightItems([item('x', 'GHOST_STEP')], DEFAULT)).not.toThrow();
    expect(inFlightItems([item('x', 'GHOST_STEP')], DEFAULT)).toEqual([]);
  });
});
