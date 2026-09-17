/**
 * @vitest-environment jsdom
 *
 * The hook's localStorage restore path, which had no test until it broke.
 *
 * useToggleSet.ts documents that a stored selection wins over the caller's
 * default, and that an explicitly stored EMPTY array round-trips as empty — a
 * user who clears every chip and refreshes must not get the defaults back.
 * Only the pure read/write helpers were tested, so when the URL-sync effect
 * (BUG 02388ec7) started overwriting restored state with the default on mount,
 * nothing failed: the selection was replaced AND persisted over, losing the
 * user's choice for good.
 */
import { renderHook } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { useToggleSet } from '../hooks/useToggleSet';

const KEY = 'agenfk-hub:test:chips';

beforeEach(() => { try { window.localStorage.clear(); } catch { /* blocked */ } });

describe('a storage-backed facet restores what the user chose', () => {
  it('prefers the stored selection over the default', () => {
    window.localStorage.setItem(KEY, JSON.stringify(['pr.opened']));
    const { result } = renderHook(() => useToggleSet(['item.closed'], { storageKey: KEY }));
    expect([...result.current.set]).toEqual(['pr.opened']);
  });

  it('does not write the default back over it', () => {
    // The half that turns "ignored for a render" into "gone for good".
    window.localStorage.setItem(KEY, JSON.stringify(['pr.opened']));
    renderHook(() => useToggleSet(['item.closed'], { storageKey: KEY }));
    expect(window.localStorage.getItem(KEY)).toBe(JSON.stringify(['pr.opened']));
  });

  it('keeps an explicitly cleared facet cleared', () => {
    window.localStorage.setItem(KEY, JSON.stringify([]));
    const { result } = renderHook(() => useToggleSet(['item.closed'], { storageKey: KEY }));
    expect([...result.current.set]).toEqual([]);
  });

  it('falls back to the default when nothing is stored', () => {
    const { result } = renderHook(() => useToggleSet(['item.closed'], { storageKey: KEY }));
    expect([...result.current.set]).toEqual(['item.closed']);
  });
});
