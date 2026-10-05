/**
 * @vitest-environment jsdom
 *
 * The control that replaced a native `<select>` of four bare words.
 *
 * What is pinned is what the select could not do: show the square and the
 * meaning of EVERY type at the moment of choosing, rather than the word of the
 * one already chosen.
 */
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ItemTypePicker } from '../components/ItemTypePicker';
import { ItemType } from '../types';
import { itemTypeHint } from '../components/ItemTypeSquare';

afterEach(() => cleanup());

const open = (value: ItemType = ItemType.TASK, onChange = vi.fn()) => {
  render(<ItemTypePicker value={value} onChange={onChange} />);
  return onChange;
};

it('shows the chosen type with its square, closed', () => {
  open();
  expect(screen.getByTestId('item-type-picker').textContent).toContain('TASK');
  expect(screen.getByTestId('item-type-picker-square')).toBeDefined();
  expect(screen.queryByRole('listbox')).toBeNull();
});

it('offers all four, each with what it means', () => {
  open();
  fireEvent.click(screen.getByTestId('item-type-picker'));
  for (const type of [ItemType.EPIC, ItemType.STORY, ItemType.TASK, ItemType.BUG]) {
    const option = screen.getByTestId(`item-type-picker-option-${type}`);
    expect(option.textContent).toContain(type);
    // The sentence that a native <option> cannot carry, on every row rather
    // than only on the one already picked.
    expect(option.textContent).toContain(itemTypeHint(type));
  }
});

it('marks the current one as selected', () => {
  open(ItemType.BUG);
  fireEvent.click(screen.getByTestId('item-type-picker'));
  expect(screen.getByTestId('item-type-picker-option-BUG').getAttribute('aria-selected')).toBe('true');
  expect(screen.getByTestId('item-type-picker-option-TASK').getAttribute('aria-selected')).toBe('false');
});

it('reports the choice and closes', () => {
  const onChange = open();
  fireEvent.click(screen.getByTestId('item-type-picker'));
  fireEvent.click(screen.getByTestId('item-type-picker-option-EPIC'));
  expect(onChange).toHaveBeenCalledWith(ItemType.EPIC);
  expect(screen.queryByRole('listbox')).toBeNull();
});

it('closes on Escape, not only by choosing', () => {
  open();
  fireEvent.click(screen.getByTestId('item-type-picker'));
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('listbox')).toBeNull();
});

it('moves through the types with the arrow keys, as a select does', () => {
  const onChange = open(ItemType.STORY);
  fireEvent.keyDown(screen.getByTestId('item-type-picker'), { key: 'ArrowDown' });
  expect(onChange).toHaveBeenCalledWith(ItemType.TASK);
});

it('stops at the ends instead of wrapping', () => {
  // Wrapping from BUG to EPIC turns "one past the end" into a different kind
  // of work, silently.
  const onChange = open(ItemType.BUG);
  fireEvent.keyDown(screen.getByTestId('item-type-picker'), { key: 'ArrowDown' });
  expect(onChange).toHaveBeenCalledWith(ItemType.BUG);
});
