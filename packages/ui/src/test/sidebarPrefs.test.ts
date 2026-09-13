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
  sortProjectsByPin,
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
