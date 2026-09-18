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
import { CardPicker, orderForPicker, filterForPicker } from '../components/CardPicker';
import type { AgEnFKItem } from '../types';

afterEach(cleanup);

const card = (id: string, title: string, status = 'IN_PROGRESS', projectId = 'p1'): AgEnFKItem =>
  ({ id, title, status, type: 'TASK', projectId } as unknown as AgEnFKItem);

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

  it('does not swallow a repeated id, which would make it a dedupe', () => {
    // Not reachable from the server, but the function is two complementary
    // filters and the name above promised more than it checked: with unique
    // input, "did not duplicate" says nothing about what happens to a repeat.
    const dupes = [card('i1', 'One'), card('i1', 'Also one'), card('i2', 'Two')];
    expect(orderForPicker(dupes, 'i1').map(i => i.title)).toEqual(['One', 'Also one', 'Two']);
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

  it('takes focus when it opens, so Escape can reach it', () => {
    /*
     * The half this test used to miss. Firing keydown AT the dialog proves the
     * handler runs; it says nothing about whether a key press ever arrives
     * there. React dispatches along the fiber tree from the event target, and
     * a dialog that never takes focus is one the keyboard never reaches — the
     * handler was unreachable in the app while this test was green.
     */
    render(<CardPicker items={THREE} currentItemId="i1" onPick={vi.fn()} onClose={vi.fn()} />);
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
  });

  it('closes on Escape pressed wherever focus actually is', () => {
    const onClose = vi.fn();
    render(<CardPicker items={THREE} currentItemId="i1" onPick={vi.fn()} onClose={onClose} />);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('says which project a card belongs to', () => {
    // The list is cross-project and the rows showed only a title, so two cards
    // with the same name in two repos were the same row — and picking one
    // re-points the board.
    render(
      <CardPicker
        items={[card('i1', 'Fix flaky test')]}
        projectNames={new Map([['p1', 'horizon-lab']])}
        onPick={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTitle('Fix flaky test').textContent).toMatch(/horizon-lab/);
  });

  it('shows the step each card is sitting in', () => {
    render(<CardPicker items={[card('i1', 'Only', 'REVIEW')]} onPick={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByTitle('Only').textContent).toMatch(/REVIEW/);
  });
});

/**
 * Narrowing a long list (CGLAB-190).
 *
 * Reported with a screenshot: the picker was a flat list running off the
 * screen, mixing projects — horizon-lab and horizon-ds interleaved.
 */
describe('filtering the cards on offer', () => {
  const MANY = [
    card('a', 'Prod VPC peering', 'REVIEW', 'p1'),
    card('b', 'Terraform standardization', 'REVIEW', 'p1'),
    card('c', 'ChatHistorySidebar component', 'REVIEW', 'p2'),
    card('d', 'Manutenção do índice', 'IN_PROGRESS', 'p2'),
  ];

  it('narrows to one project', () => {
    expect(filterForPicker(MANY, { projectId: 'p2' }).map(i => i.id)).toEqual(['c', 'd']);
  });

  it('matches part of a title, in any case', () => {
    expect(filterForPicker(MANY, { query: 'TERRAFORM' }).map(i => i.id)).toEqual(['b']);
  });

  it('finds an accented title without the accents', () => {
    /*
     * Card titles here are written in Portuguese as often as in English.
     * Requiring someone to type "manutenção" exactly, accent and all, to find
     * their own card is a search box that punishes you for using it.
     */
    expect(filterForPicker(MANY, { query: 'manutencao' }).map(i => i.id)).toEqual(['d']);
    expect(filterForPicker(MANY, { query: 'indice' }).map(i => i.id)).toEqual(['d']);
  });

  it('combines the project filter with the search', () => {
    expect(filterForPicker(MANY, { projectId: 'p1', query: 'prod' }).map(i => i.id)).toEqual(['a']);
    expect(filterForPicker(MANY, { projectId: 'p2', query: 'prod' })).toEqual([]);
  });

  it('returns everything when asked for nothing', () => {
    expect(filterForPicker(MANY)).toHaveLength(4);
    expect(filterForPicker(MANY, { query: '   ' })).toHaveLength(4);
  });

  it('keeps the current card first among what survives the filter', () => {
    // Order is applied AFTER the filter: being first only means anything
    // among the cards actually on offer.
    const out = orderForPicker(filterForPicker(MANY, { projectId: 'p2' }), 'd');
    expect(out.map(i => i.id)).toEqual(['d', 'c']);
  });
});

describe('the picker with something to narrow', () => {
  const MANY = Array.from({ length: 8 }, (_, i) =>
    card(`i${i}`, `Card number ${i}`, 'IN_PROGRESS', i < 4 ? 'p1' : 'p2'));
  const NAMES = new Map([['p1', 'horizon-lab'], ['p2', 'horizon-ds']]);

  const open = () =>
    render(<CardPicker items={MANY} projectNames={NAMES} onPick={vi.fn()} onClose={vi.fn()} />);

  it('offers a search box and a project filter', () => {
    open();
    expect(screen.getByRole('searchbox', { name: /search cards/i })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: /filter by project/i })).toBeTruthy();
  });

  it('shows only what matches what was typed', () => {
    open();
    fireEvent.change(screen.getByRole('searchbox', { name: /search cards/i }), { target: { value: 'number 3' } });
    expect(screen.getByTitle('Card number 3')).toBeTruthy();
    expect(screen.queryByTitle('Card number 4')).toBeNull();
  });

  it('shows only the chosen project', () => {
    open();
    fireEvent.change(screen.getByRole('combobox', { name: /filter by project/i }), { target: { value: 'p2' } });
    expect(screen.getByTitle('Card number 4')).toBeTruthy();
    expect(screen.queryByTitle('Card number 0')).toBeNull();
  });

  it('says a search found nothing, not that the board is empty', () => {
    /*
     * "No work in flight" here would tell the user their board is empty when
     * they simply mistyped — a confident wrong answer, which is how people
     * stop trusting a filter.
     */
    open();
    fireEvent.change(screen.getByRole('searchbox', { name: /search cards/i }), { target: { value: 'zzzz' } });
    expect(screen.getByText(/no card matches that/i)).toBeTruthy();
    expect(screen.queryByText(/no work in flight/i)).toBeNull();
  });

  it('does not offer a project that has nothing in flight', () => {
    // A filter that can only ever empty the list is not a filter.
    open();
    const options = Array.from(screen.getByRole('combobox', { name: /filter by project/i }).querySelectorAll('option'));
    expect(options.map(o => o.textContent)).toEqual(['All projects', 'horizon-ds', 'horizon-lab']);
  });
});

describe('the picker with only a handful', () => {
  it('draws no search box, because there is nothing to narrow', () => {
    // A search box over three cards is furniture.
    render(<CardPicker items={THREE} projectNames={new Map([['p1', 'horizon-lab']])} onPick={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByRole('searchbox')).toBeNull();
  });
});

/**
 * The empty state gets a way out (CGLAB-164).
 *
 * Both empty branches are a sentence and nothing else. "No work in flight.
 * Start a card on the board, then open a terminal on it" tells someone to
 * leave this dialog, find the board, find the project, hover it and press a
 * `+` they have to already know about — which is the exact question that
 * opened this card: "I'm starting a task from nothing, where do I write it?"
 *
 * Two doors, because there are two people here: the one who knows what the
 * card says and the one holding an objective they have not decomposed yet.
 * Only the first door is built. The second is drawn, disabled, and says why —
 * the decomposer does not exist (`analyze_request` echoes the request and
 * prints four static rules), and it belongs to another card.
 */
describe('the way out of an empty picker', () => {
  it('offers to create a card when nothing is in flight', () => {
    const onCreateCard = vi.fn();
    render(<CardPicker items={[]} onPick={vi.fn()} onClose={vi.fn()} onCreateCard={onCreateCard} />);
    fireEvent.click(screen.getByRole('button', { name: /create a card/i }));
    expect(onCreateCard).toHaveBeenCalled();
  });

  it('offers the same door when a search found nothing', () => {
    // A mistyped search and an empty board are different facts — the picker
    // already refuses to conflate them — but the way out is the same.
    const MANY = Array.from({ length: 8 }, (_, i) => card(`i${i}`, `Card number ${i}`));
    render(<CardPicker items={MANY} onPick={vi.fn()} onClose={vi.fn()} onCreateCard={vi.fn()} />);
    fireEvent.change(screen.getByRole('searchbox', { name: /search cards/i }), { target: { value: 'zzzz' } });
    expect(screen.getByText(/no card matches that/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /create a card/i })).toBeTruthy();
  });

  it('offers to clear the search before it offers to create anything', () => {
    /*
     * Order matters here and it is not cosmetic. After a failed search the
     * overwhelmingly likely fix is a typo, not a missing card — putting
     * "create" first invites someone to make a duplicate of the card they
     * were looking for.
     */
    const MANY = Array.from({ length: 8 }, (_, i) => card(`i${i}`, `Card number ${i}`));
    render(<CardPicker items={MANY} onPick={vi.fn()} onClose={vi.fn()} onCreateCard={vi.fn()} />);
    fireEvent.change(screen.getByRole('searchbox', { name: /search cards/i }), { target: { value: 'zzzz' } });
    const buttons = screen.getAllByRole('button').map(b => b.textContent ?? '');
    const clear = buttons.findIndex(t => /clear the search/i.test(t));
    const create = buttons.findIndex(t => /create a card/i.test(t));
    expect(clear).toBeGreaterThanOrEqual(0);
    expect(create).toBeGreaterThan(clear);
  });

  it('puts the cards back when the search is cleared', () => {
    const MANY = Array.from({ length: 8 }, (_, i) => card(`i${i}`, `Card number ${i}`));
    render(<CardPicker items={MANY} onPick={vi.fn()} onClose={vi.fn()} onCreateCard={vi.fn()} />);
    fireEvent.change(screen.getByRole('searchbox', { name: /search cards/i }), { target: { value: 'zzzz' } });
    fireEvent.click(screen.getByRole('button', { name: /clear the search/i }));
    expect(screen.getByTitle('Card number 0')).toBeTruthy();
    expect(screen.queryByText(/no card matches that/i)).toBeNull();
  });

  it('draws no create door when the caller has nowhere to create into', () => {
    // No active project means no project to put the card in. A door onto
    // nothing is the defect this card exists to fix, not a smaller version
    // of it.
    render(<CardPicker items={[]} onPick={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /create a card/i })).toBeNull();
    expect(screen.getByText(/no work in flight/i)).toBeTruthy();
  });

  it('shows Ask AgEnFK, disabled, with the reason said in words', () => {
    /*
     * The one thing this must not do is promise. The decomposer is not built:
     * `analyze_request` echoes the request back and prints four static rules,
     * and there is no endpoint that decomposes anything. Drawn and disabled
     * says "this is coming and it is not here"; a live-looking button says
     * "this works", and finding out it does not is how a control loses its
     * credit permanently.
     */
    render(<CardPicker items={[]} onPick={vi.fn()} onClose={vi.fn()} onCreateCard={vi.fn()} />);
    const ask = screen.getByRole('button', { name: /ask agenfk/i }) as HTMLButtonElement;
    expect(ask.disabled).toBe(true);
    // The reason is on screen, not in a tooltip nobody opens.
    expect(screen.getByTestId('ask-agenfk-reason').textContent).toMatch(/not built|not here yet|coming/i);
  });

  it('never fires anything when Ask AgEnFK is clicked', () => {
    const onCreateCard = vi.fn();
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(<CardPicker items={[]} onPick={onPick} onClose={onClose} onCreateCard={onCreateCard} />);
    fireEvent.click(screen.getByRole('button', { name: /ask agenfk/i }));
    expect(onCreateCard).not.toHaveBeenCalled();
    expect(onPick).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps the doors out of the way when there are cards to pick', () => {
    // The picker's job is picking. The doors belong to the state where there
    // is nothing to pick.
    render(<CardPicker items={THREE} onPick={vi.fn()} onClose={vi.fn()} onCreateCard={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /create a card/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /ask agenfk/i })).toBeNull();
  });
});
