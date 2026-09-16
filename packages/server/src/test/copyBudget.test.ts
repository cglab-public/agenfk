/**
 * Measure first, refuse before the first byte (CGLAB-196).
 *
 * THE REASON THE ORDER MATTERS is not tidiness: `fs.cp` ignores its `signal`
 * option, so a copy that has started cannot be cancelled. Aborting halfway
 * leaves a partial tree nobody can interpret - not the next agent, not the
 * person looking at it. Refusing before anything is written keeps the worktree
 * in a state somebody can reason about, and that is worth walking the tree
 * twice for.
 *
 * THE FAILURE THIS GUARDS is a budget in bytes alone. 200,000 tiny files weigh
 * almost nothing and take minutes, so bytes-only passes exactly the payload
 * that freezes worktree creation.
 */
import { describe, it, expect } from 'vitest';
import {
  planCopy,
  sizingLimit,
  MAX_COPY_BYTES,
  MAX_COPY_ENTRIES,
  SIZING_HEADROOM,
} from '../copyBudget';

const entry = (path: string, bytes: number, entries = 1) => ({ path, bytes, entries });
const MB = 1024 * 1024;

describe('what it lets through', () => {
  it('accepts the small things a worktree must own', () => {
    // The payload this exists FOR: a .env, an editor setting, a build cache.
    const plan = planCopy([
      entry('.env', 512),
      entry('.vscode/settings.json', 2048),
      entry('.cache/', 40 * MB, 900),
    ]);
    expect(plan.accepted).toEqual(['.env', '.vscode/settings.json', '.cache/']);
    expect(plan.refused).toEqual([]);
  });

  it('accepts exactly at the limits, so the edge is not a coin flip', () => {
    const plan = planCopy([entry('edge', MAX_COPY_BYTES, MAX_COPY_ENTRIES)]);
    expect(plan.accepted).toEqual(['edge']);
  });
});

describe('what it refuses, and why it says so', () => {
  it('refuses a dependency tree by size', () => {
    // 939 MB of node_modules against 8.1 MB of source is the case this number
    // was chosen against.
    const plan = planCopy([entry('node_modules', 3 * 1024 * MB, 200_000)]);
    expect(plan.accepted).toEqual([]);
    expect(plan.refused[0].reason).toMatch(/installed, not copied/i);
  });

  it('refuses many tiny files, and does NOT call them large', () => {
    /*
     * THE test that bytes-only would fail. The thing is small and slow, and
     * somebody told it was "too big" goes looking for size to reduce - which
     * is a wrong afternoon.
     */
    const plan = planCopy([entry('tiny-forest', 10 * MB, MAX_COPY_ENTRIES + 1)]);
    expect(plan.accepted).toEqual([]);
    expect(plan.refused[0].reason).toMatch(/numerous/i);
    expect(plan.refused[0].reason, 'a small slow directory was called large').not.toMatch(/\bGB\b/);
  });

  it('names the path and both numbers, so the refusal is checkable', () => {
    const plan = planCopy([entry('huge', 5 * 1024 * MB, 3)]);
    expect(plan.refused[0].path).toBe('huge');
    expect(plan.refused[0].reason).toContain('huge');
    expect(plan.refused[0].reason).toMatch(/5\.0 GB/);
  });
});

describe('one refusal does not poison the list', () => {
  it('still copies the .env listed after node_modules', () => {
    /*
     * THE test. Each entry is judged on its own rather than against a running
     * total: letting the first consume the budget would refuse the second for
     * a reason that has nothing to do with it, and the person would go looking
     * at their .env.
     */
    const plan = planCopy([
      entry('node_modules', 3 * 1024 * MB, 200_000),
      entry('.env', 512),
    ]);
    expect(plan.accepted, 'a refused entry starved the ones after it').toEqual(['.env']);
    expect(plan.refused.map(r => r.path)).toEqual(['node_modules']);
  });

  it('reports every refusal, not just the first', () => {
    // A caller fixing them one at a time discovers the next only by trying
    // again, which is the slowest possible loop.
    const plan = planCopy([
      entry('a', 3 * 1024 * MB),
      entry('b', 1024, MAX_COPY_ENTRIES + 1),
      entry('c', 10),
    ]);
    expect(plan.refused.map(r => r.path)).toEqual(['a', 'b']);
    expect(plan.accepted).toEqual(['c']);
  });

  it('totals only what was accepted', () => {
    // Totalling the refused ones would report a copy that is not going to
    // happen, and the number is the one thing a caller might log.
    const plan = planCopy([entry('big', 3 * 1024 * MB, 5), entry('small', 100, 2)]);
    expect(plan.totalBytes).toBe(100);
    expect(plan.totalEntries).toBe(2);
  });
});

describe('an empty list', () => {
  it('plans nothing and refuses nothing', () => {
    // A repo with no include list is the common case, not an error.
    expect(planCopy([])).toEqual({ accepted: [], refused: [], totalBytes: 0, totalEntries: 0 });
  });
});

describe('the numbers', () => {
  it('limits bytes AND entries, because either alone lets the bad case through', () => {
    expect(MAX_COPY_BYTES).toBe(2 * 1024 * 1024 * 1024);
    expect(MAX_COPY_ENTRIES).toBe(50_000);
  });

  it('gives the sizing walk headroom over the copy budget', () => {
    /*
     * So one refused directory cannot starve the entries after it: measuring
     * must be able to get PAST node_modules to reach the .env, and a sizing
     * walk bounded at exactly the copy budget would stop there.
     */
    const limit = sizingLimit();
    expect(limit.maxBytes).toBe(MAX_COPY_BYTES * SIZING_HEADROOM);
    expect(limit.maxEntries).toBe(MAX_COPY_ENTRIES * SIZING_HEADROOM);
  });

  it('honours a budget set deliberately', () => {
    const tight = { maxBytes: 1000, maxEntries: 5 };
    expect(planCopy([entry('x', 2000)], tight).accepted).toEqual([]);
    expect(planCopy([entry('x', 500, 2)], tight).accepted).toEqual(['x']);
  });
});
