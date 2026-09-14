/**
 * Choosing which card a new terminal opens on (CGLAB-184).
 *
 * The `+` in the terminal strip reopened on the ACTIVE session's card and
 * nothing else, so there was no route from the Terminal view to any other card.
 * And with no active session it did nothing at all — no dialog, no message, not
 * even a disabled state — which reads as a broken app rather than as a control
 * with nothing to act on.
 */
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { CardPicker, orderForPicker } from '../components/CardPicker';
import type { AgEnFKItem } from '../types';

afterEach(cleanup);

const card = (id: string, title: string, status = 'IN_PROGRESS'): AgEnFKItem =>
  ({ id, title, status, type: 'TASK', projectId: 'p1' } as unknown as AgEnFKItem);

const THREE = [card('i1', 'First thing'), card('i2', 'Second thing'), card('i3', 'Third thing')];

describe('the order cards are offered in', () => {
  it('puts the card you are on first', () => {
    // The overwhelmingly common reason to press + is a second agent on the
    // card you are already looking at. Making that the first row costs the
    // other cases nothing.
    expect(orderForPicker(THREE, 'i3').map(i => i.id)).toEqual(['i3', 'i1', 'i2']);
  });

  it('leaves the rest in the order they arrived', () => {
    // Not sorted by title or step: a list that reshuffles itself between
    // openings is harder to use than one that does not.
    expect(orderForPicker(THREE, 'i2').map(i => i.id)).toEqual(['i2', 'i1', 'i3']);
  });

  it('copes with being on a card that is not in the list', () => {
    // Reachable: a terminal outlives its card leaving the active-work list.
    expect(orderForPicker(THREE, 'gone').map(i => i.id)).toEqual(['i1', 'i2', 'i3']);
  });

  it('copes with being on no card at all', () => {
    expect(orderForPicker(THREE, undefined).map(i => i.id)).toEqual(['i1', 'i2', 'i3']);
  });

  it('never drops or duplicates a card', () => {
    for (const id of ['i1', 'i2', 'i3', 'nope', undefined]) {
      const out = orderForPicker(THREE, id);
      expect(out).toHaveLength(3);
      expect(new Set(out.map(i => i.id)).size).toBe(3);
    }
  });
});

describe('the picker', () => {
  it('offers every card in flight, not only the one you are on', () => {
    // The defect itself: there was no route from the Terminal view to any
    // other card.
    render(<CardPicker items={THREE} currentItemId="i1" onPick={vi.fn()} onClose={vi.fn()} />);
    for (const title of ['First thing', 'Second thing', 'Third thing']) {
      expect(screen.getByTitle(title)).toBeTruthy();
    }
  });

  it('hands back the card that was chosen', () => {
    const onPick = vi.fn();
    render(<CardPicker items={THREE} currentItemId="i1" onPick={onPick} onClose={vi.fn()} />);
    fireEvent.click(screen.getByTitle('Third thing'));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: 'i3' }));
  });

  it('says which one you are on in words, not only in colour', () => {
    // A background tint is not available to everyone.
    render(<CardPicker items={THREE} currentItemId="i2" onPick={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByTitle('Second thing').textContent).toMatch(/current/i);
    expect(screen.getByTitle('First thing').textContent).not.toMatch(/current/i);
  });

  it('answers an empty list with a sentence, not an empty box', () => {
    // This is the state the + used to answer with silence. "Nothing is in
    // flight" tells the user what to do next; a blank panel does not.
    render(<CardPicker items={[]} currentItemId={undefined} onPick={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText(/no work in flight/i)).toBeTruthy();
  });

  it('closes on Escape, so it is not a trap without a pointer', () => {
    const onClose = vi.fn();
    render(<CardPicker items={THREE} currentItemId="i1" onPick={vi.fn()} onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('shows the step each card is sitting in', () => {
    render(<CardPicker items={[card('i1', 'Only', 'REVIEW')]} onPick={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByTitle('Only').textContent).toMatch(/REVIEW/);
  });
});
