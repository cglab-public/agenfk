/**
 * The rule both reorder affordances have to agree on.
 *
 * Written before the drag handlers, because the interesting part of a drag is
 * not the DOM events — it is where the tab lands, and that is a question about
 * two indices that can be asked without a pointer.
 *
 * The case that pins the whole design is dragging RIGHTWARD. Remove-then-insert
 * silently shifts every index after the removal, so the naive version lands the
 * tab one slot short of where the pointer was, which reads as the drag having
 * missed.
 */
import { describe, it, expect } from 'vitest';
import { moveTab } from '../tabReorder';

const BAR = ['kanban', 'terminal', 'runs', 'settings'] as const;

describe('moving a tab', () => {
  it('drops it into the slot it was dragged onto, moving right', () => {
    // Dragged kanban onto runs: kanban is now where runs was.
    expect(moveTab(BAR, 'kanban', 'runs')).toEqual(['terminal', 'runs', 'kanban', 'settings']);
  });

  it('drops it into the slot it was dragged onto, moving left', () => {
    expect(moveTab(BAR, 'settings', 'terminal')).toEqual(['kanban', 'settings', 'terminal', 'runs']);
  });

  it('handles the neighbour case, which is what the arrow button does', () => {
    // The arrow is a one-step version of exactly this, and expressing it in
    // terms of moveTab is why it cannot drift from the drag.
    expect(moveTab(BAR, 'runs', 'terminal')).toEqual(['kanban', 'runs', 'terminal', 'settings']);
  });

  it('moves a tab to the very front', () => {
    expect(moveTab(BAR, 'settings', 'kanban')).toEqual(['settings', 'kanban', 'terminal', 'runs']);
  });

  it('moves a tab to the very back', () => {
    expect(moveTab(BAR, 'kanban', 'settings')).toEqual(['terminal', 'runs', 'settings', 'kanban']);
  });

  it('keeps every tab, exactly once', () => {
    // A splice that drops or duplicates an entry makes a view unreachable or
    // renders it twice, and both look like the bar broke rather than like the
    // drag missed.
    for (const moved of BAR) {
      for (const target of BAR) {
        const out = moveTab(BAR, moved, target);
        expect(out).toHaveLength(BAR.length);
        expect([...out].sort()).toEqual([...BAR].sort());
      }
    }
  });
});

describe('drags that decide nothing', () => {
  it('dropping a tab on itself leaves the order alone', () => {
    expect(moveTab(BAR, 'runs', 'runs')).toEqual([...BAR]);
  });

  it('dropping onto something that is not in the bar leaves the order alone', () => {
    // The drop landed off the tablist, or on a tab from a build that has views
    // this one does not. Refusing beats guessing at an index.
    expect(moveTab(BAR, 'runs', 'nope')).toEqual([...BAR]);
  });

  it('dragging something that is not in the bar leaves the order alone', () => {
    expect(moveTab(BAR, 'nope', 'runs')).toEqual([...BAR]);
  });

  it('never hands back the array it was given', () => {
    // A setter returning its own argument skips the render, which is fine here
    // and a trap for the next caller.
    const input = [...BAR];
    expect(moveTab(input, 'runs', 'runs')).not.toBe(input);
  });

  it('does not mutate the order it was given', () => {
    const input = [...BAR];
    moveTab(input, 'kanban', 'settings');
    expect(input).toEqual([...BAR]);
  });
});
