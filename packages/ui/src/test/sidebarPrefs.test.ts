/**
 * @vitest-environment jsdom
 *
 * CGLAB-172: which projects are pinned, and which folders are open.
 *
 * These are preferences of the person at this machine, not state of the work,
 * so they live in localStorage and never touch the server. That makes the
 * storage layer the whole risk surface: a corrupt or hand-edited value must
 * degrade to "nothing pinned", never take the sidebar down with it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  readPinned, togglePinned, isPinned,
  readExpanded, toggleExpanded, isExpanded,
  sortProjectsByPin, readProjectSort, writeProjectSort, orderProjects,
  touchProjectUsed,
  readLastUsed,
} from '../sidebarPrefs';

beforeEach(() => localStorage.clear());

describe('pinned projects', () => {
  it('starts with nothing pinned', () => {
    expect(readPinned()).toEqual([]);
  });

  it('pins and unpins a project', () => {
    togglePinned('p1');
    expect(isPinned('p1')).toBe(true);
    togglePinned('p1');
    expect(isPinned('p1')).toBe(false);
  });

  it('keeps pins in the order they were added', () => {
    togglePinned('p2');
    togglePinned('p1');
    expect(readPinned()).toEqual(['p2', 'p1']);
  });

  it('survives a reload — that is the whole point of persisting it', () => {
    togglePinned('p1');
    expect(readPinned()).toEqual(['p1']);        // same process, fresh read
    expect(localStorage.getItem('agenfk_pinned_projects')).toContain('p1');
  });

  it('never pins the same project twice', () => {
    togglePinned('p1');
    togglePinned('p1');
    togglePinned('p1');
    expect(readPinned()).toEqual(['p1']);
  });

  it('degrades to nothing pinned when the stored value is corrupt', () => {
    localStorage.setItem('agenfk_pinned_projects', '{not json');
    expect(readPinned()).toEqual([]);
    expect(() => isPinned('p1')).not.toThrow();
  });

  it('ignores a stored value of the wrong shape', () => {
    // Hand-edited or written by an older version.
    localStorage.setItem('agenfk_pinned_projects', '{"p1":true}');
    expect(readPinned()).toEqual([]);
  });

  it('drops non-string entries rather than rendering them', () => {
    localStorage.setItem('agenfk_pinned_projects', '["p1", 42, null, "p2"]');
    expect(readPinned()).toEqual(['p1', 'p2']);
  });
});

describe('sortProjectsByPin', () => {
  const projects = [
    { id: 'a', name: 'alpha' },
    { id: 'b', name: 'beta' },
    { id: 'c', name: 'gamma' },
  ];

  it('leaves order untouched when nothing is pinned', () => {
    expect(sortProjectsByPin(projects, []).map(p => p.id)).toEqual(['a', 'b', 'c']);
  });

  it('lifts pinned projects to the top', () => {
    expect(sortProjectsByPin(projects, ['c']).map(p => p.id)).toEqual(['c', 'a', 'b']);
  });

  it('orders several pins by when they were pinned, not alphabetically', () => {
    expect(sortProjectsByPin(projects, ['c', 'a']).map(p => p.id)).toEqual(['c', 'a', 'b']);
  });

  it('ignores a pin for a project that no longer exists', () => {
    // A deleted project must not leave a hole or a ghost row.
    expect(sortProjectsByPin(projects, ['deleted', 'b']).map(p => p.id)).toEqual(['b', 'a', 'c']);
  });

  it('does not mutate the array it was given', () => {
    const original = [...projects];
    sortProjectsByPin(projects, ['c']);
    expect(projects).toEqual(original);
  });
});

describe('expanded folders', () => {
  it('remembers per project, independently', () => {
    toggleExpanded('p1');
    expect(isExpanded('p1')).toBe(true);
    expect(isExpanded('p2')).toBe(false);
  });

  it('collapses again on a second toggle', () => {
    toggleExpanded('p1');
    toggleExpanded('p1');
    expect(isExpanded('p1')).toBe(false);
  });

  it('degrades to all-collapsed when the stored value is corrupt', () => {
    localStorage.setItem('agenfk_expanded_projects', 'nonsense');
    expect(readExpanded()).toEqual([]);
  });

  it('survives localStorage being unavailable', () => {
    // Private browsing and quota-exceeded both throw on setItem. Losing a
    // preference is a papercut; throwing here would blank the sidebar.
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new Error('QuotaExceededError'); };
    try {
      expect(() => togglePinned('p1')).not.toThrow();
      expect(() => toggleExpanded('p1')).not.toThrow();
    } finally {
      Storage.prototype.setItem = original;
    }
  });
});

describe('pinned projects — corrupt storage', () => {
  it('dedupes repeated ids so a project cannot render twice', () => {
    // A hand-edited or double-written value would otherwise produce two rows
    // for one project, with duplicate React keys.
    localStorage.setItem('agenfk_pinned_projects', '["p1","p2","p1"]');
    expect(readPinned()).toEqual(['p1', 'p2']);

    const projects = [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }];
    expect(sortProjectsByPin(projects, readPinned()).map(p => p.id)).toEqual(['p1', 'p2', 'p3']);
  });

  it('does not duplicate a row even when the caller passes repeats directly', () => {
    const projects = [{ id: 'a' }, { id: 'b' }];
    const sorted = sortProjectsByPin(projects, ['a', 'a']);
    expect(sorted.map(p => p.id)).toEqual(['a', 'b']);
  });
});


describe('project sort order', () => {
  const projects = [
    { id: 'old-but-busy', name: 'zeta', createdAt: '2024-01-01T00:00:00Z', updatedAt: '2026-09-13T00:00:00Z' },
    { id: 'new-and-idle', name: 'alpha', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2024-06-01T00:00:00Z' },
  ];

  it('defaults to last used, which is what you reach for', () => {
    expect(readProjectSort()).toBe('last-used');
  });

  it('remembers the choice', () => {
    writeProjectSort('created');
    expect(readProjectSort()).toBe('created');
  });

  it('ignores a stored value that is not a known order', () => {
    localStorage.setItem('agenfk_project_sort', 'by-vibes');
    expect(readProjectSort()).toBe('last-used');
  });

  it('puts the most recently used first', () => {
    expect(orderProjects(projects, 'last-used').map(p => p.id)).toEqual(['old-but-busy', 'new-and-idle']);
  });

  it('puts the most recently created first — a different answer', () => {
    // The two orders must actually differ, or the setting is decoration.
    expect(orderProjects(projects, 'created').map(p => p.id)).toEqual(['new-and-idle', 'old-but-busy']);
  });

  it('does not mutate the array it was given', () => {
    const copy = [...projects];
    orderProjects(projects, 'created');
    expect(projects).toEqual(copy);
  });

  it('tolerates a project with no dates rather than dropping it', () => {
    const withGap = [...projects, { id: 'dateless', name: 'ghost' }];
    expect(orderProjects(withGap as never, 'last-used')).toHaveLength(3);
  });

  it('keeps pinned projects on top whichever order is chosen', () => {
    // Pinning is a stronger statement than any sort.
    const ordered = sortProjectsByPin(orderProjects(projects, 'created'), ['old-but-busy']);
    expect(ordered[0].id).toBe('old-but-busy');
  });
});

describe('"Last used" has to mean last used', () => {
  // It sorted by Project.updatedAt, which the server writes only when a
  // project's NAME, description, verifyCommand or flow changes. Creating,
  // moving or finishing an item never touches it, and nothing anywhere
  // recorded that a project was opened. So "Last used" and "Created at"
  // returned the same order on virtually every install — and "Last used" is
  // the default, so the mislabelled one was the one people saw.
  //
  // Opening a project is a local act, so it is recorded locally. That is also
  // more truthful than the server field: it is when *you* last worked here.

  it('puts the project you just opened first, whatever its timestamps say', () => {
    const older = { id: 'p1', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' };
    const newer = { id: 'p2', createdAt: '2026-02-01T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z' };
    // p1 loses on both server timestamps, and still wins once opened.
    touchProjectUsed('p1');
    expect(orderProjects([newer, older], 'last-used').map(p => p.id)).toEqual(['p1', 'p2']);
  });

  it('orders several opened projects by when each was opened', () => {
    touchProjectUsed('p1');
    touchProjectUsed('p2');
    touchProjectUsed('p3');
    const projects = [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }];
    expect(orderProjects(projects, 'last-used').map(p => p.id)).toEqual(['p3', 'p2', 'p1']);
  });

  it('re-opening an old project lifts it back to the top', () => {
    touchProjectUsed('p1');
    touchProjectUsed('p2');
    touchProjectUsed('p1');
    expect(orderProjects([{ id: 'p1' }, { id: 'p2' }], 'last-used').map(p => p.id)).toEqual(['p1', 'p2']);
  });

  it('falls back to updatedAt for projects never opened on this machine', () => {
    // A fresh install has no local history at all; the list still has to have
    // a sensible order rather than collapsing to input order.
    const a = { id: 'a', updatedAt: '2026-01-01T00:00:00.000Z' };
    const b = { id: 'b', updatedAt: '2026-06-01T00:00:00.000Z' };
    expect(orderProjects([a, b], 'last-used').map(p => p.id)).toEqual(['b', 'a']);
  });

  it('ranks any opened project above one that was never opened', () => {
    const neverOpened = { id: 'fresh', updatedAt: '2099-01-01T00:00:00.000Z' };
    const opened = { id: 'mine', updatedAt: '2000-01-01T00:00:00.000Z' };
    touchProjectUsed('mine');
    expect(orderProjects([neverOpened, opened], 'last-used').map(p => p.id)).toEqual(['mine', 'fresh']);
  });

  it('leaves "Created at" alone — it must not follow local usage', () => {
    const a = { id: 'a', createdAt: '2026-01-01T00:00:00.000Z' };
    const b = { id: 'b', createdAt: '2026-06-01T00:00:00.000Z' };
    touchProjectUsed('a');
    expect(orderProjects([a, b], 'created').map(p => p.id)).toEqual(['b', 'a']);
  });

  it('does not grow without bound as projects come and go', () => {
    for (let i = 0; i < 200; i += 1) touchProjectUsed(`p${i}`);
    expect(Object.keys(readLastUsed()).length).toBeLessThanOrEqual(50);
    // The most recent must survive the trim; the oldest is the one to drop.
    expect(readLastUsed()['p199']).toBeDefined();
    expect(readLastUsed()['p0']).toBeUndefined();
  });

  it('rejects a counter too large to ever be outranked', () => {
    // isFinite is not enough. At 1e308 `highest + 1 === highest`, so the next
    // project opened TIES instead of outranking and the poisoned entry sits at
    // the top forever. Only safe non-negative integers are ranks.
    localStorage.setItem('agenfk_project_last_used', JSON.stringify({ poison: 1e308, ok: 3 }));
    expect(readLastUsed()['poison']).toBeUndefined();
    expect(readLastUsed()['ok']).toBe(3);

    touchProjectUsed('fresh');
    expect(readLastUsed()['fresh']).toBeGreaterThan(3);
  });

  it('rejects a negative counter', () => {
    localStorage.setItem('agenfk_project_last_used', JSON.stringify({ bad: -5, ok: 1 }));
    expect(readLastUsed()['bad']).toBeUndefined();
  });

  it('survives hostile storage without blanking the sidebar', () => {
    localStorage.setItem('agenfk_project_last_used', '{"p1": "not a number"');
    expect(() => readLastUsed()).not.toThrow();
    expect(orderProjects([{ id: 'p1' }], 'last-used').map(p => p.id)).toEqual(['p1']);
  });
});
