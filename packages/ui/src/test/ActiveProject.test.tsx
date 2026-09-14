/**
 * @vitest-environment jsdom
 *
 * CGLAB-168: which project is open is now shared, not private to the board.
 *
 * It used to be `useState` inside KanbanBoard, which was fine while the board
 * was the only thing on screen. The desktop sidebar has to both show the
 * active project and change it, so the state moves up — with the same rules it
 * always had: a `?project=` deep link beats the remembered one, and every
 * change is remembered for next launch.
 */
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { ActiveProjectProvider, useActiveProject } from '../ActiveProject';
import { readLastUsed } from '../sidebarPrefs';

function Probe() {
  const { activeProjectId, setActiveProjectId, focusedItemId, focusItem, newItemRequest, requestNewItem } = useActiveProject();
  return (
    <div>
      <span data-testid="active">{activeProjectId ?? 'none'}</span>
      <span data-testid="focused">{focusedItemId ?? 'none'}</span>
      <button onClick={() => setActiveProjectId('p2')}>pick p2</button>
      <button onClick={() => setActiveProjectId(null)}>clear project</button>
      <button onClick={() => setActiveProjectId('p3')}>pick p3</button>
      <button onClick={() => focusItem('i9', 'p2')}>focus i9 in p2</button>
      <button onClick={() => focusItem('i9', 'p2')}>focus i9 again</button>
      <span data-testid="new-item">{newItemRequest ?? 'none'}</span>
      <button onClick={() => requestNewItem('p2')}>new in p2</button>
      <button onClick={() => requestNewItem('p2')}>new in p2 again</button>
    </div>
  );
}

const renderProbe = () =>
  render(<ActiveProjectProvider><Probe /></ActiveProjectProvider>);

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/');
});
afterEach(() => cleanup());

describe('ActiveProjectProvider', () => {
  it('starts with nothing chosen on a first run', () => {
    renderProbe();
    expect(screen.getByTestId('active').textContent).toBe('none');
  });

  it('restores the project remembered from last time', () => {
    localStorage.setItem('agenfk_project_id', 'p-remembered');
    renderProbe();
    expect(screen.getByTestId('active').textContent).toBe('p-remembered');
  });

  it('lets a ?project= deep link win over the remembered one', () => {
    // `agenfk ui --open <id>&project=<pid>` has to land on the project the
    // caller asked for, not on whatever was last opened here.
    localStorage.setItem('agenfk_project_id', 'p-remembered');
    window.history.replaceState({}, '', '/?project=p-from-link');
    renderProbe();
    expect(screen.getByTestId('active').textContent).toBe('p-from-link');
  });

  it('remembers a change so the next launch reopens it', () => {
    renderProbe();
    act(() => { fireEvent.click(screen.getByText('pick p2')); });
    expect(screen.getByTestId('active').textContent).toBe('p2');
    expect(localStorage.getItem('agenfk_project_id')).toBe('p2');
  });

  it('shares one value between two consumers', () => {
    // The point of lifting it: the sidebar and the board must never disagree
    // about which project is open.
    function Two() {
      const { activeProjectId } = useActiveProject();
      return <span data-testid="second">{activeProjectId ?? 'none'}</span>;
    }
    render(
      <ActiveProjectProvider>
        <Probe />
        <Two />
      </ActiveProjectProvider>,
    );
    act(() => { fireEvent.click(screen.getByText('pick p2')); });
    expect(screen.getByTestId('second').textContent).toBe('p2');
  });

  it('throws a useful error when used without its provider', () => {
    // Unlike the socket, a missing provider here is not survivable — a board
    // with no shared project state would silently show the wrong data.
    const quiet = console.error;
    console.error = () => {};
    try {
      expect(() => render(<Probe />)).toThrow(/ActiveProjectProvider/);
    } finally {
      console.error = quiet;
    }
  });
});


describe('focusing a card', () => {
  it('starts with nothing focused', () => {
    renderProbe();
    expect(screen.getByTestId('focused').textContent).toBe('none');
  });

  it('records which card to go to', () => {
    renderProbe();
    act(() => { fireEvent.click(screen.getByText('focus i9 in p2')); });
    expect(screen.getByTestId('focused').textContent).toContain('i9');
  });

  it('switches project when the card lives in another one', () => {
    // Focusing a card from the sidebar has to bring its board with it, or the
    // board searches for an id it does not have.
    renderProbe();
    act(() => { fireEvent.click(screen.getByText('focus i9 in p2')); });
    expect(screen.getByTestId('active').textContent).toBe('p2');
  });

  it('re-focusing the same card is not a no-op', () => {
    // Clicking the same sidebar row twice must scroll back to it. A plain id
    // would compare equal and the board would never react the second time.
    renderProbe();
    act(() => { fireEvent.click(screen.getByText('focus i9 in p2')); });
    const first = screen.getByTestId('focused').textContent;
    act(() => { fireEvent.click(screen.getByText('focus i9 again')); });
    expect(screen.getByTestId('focused').textContent).not.toBe(first);
  });

  it('does not persist the focus — it is a navigation, not a preference', () => {
    // Asserting that one invented key is null proved nothing: no code writes
    // or reads 'agenfk_focused_item', so the assertion held with the provider
    // deleted. Compare the whole of storage instead, and allow exactly the one
    // key focusItem is supposed to touch (it switches project as a side
    // effect). Anything else the provider starts persisting fails this.
    renderProbe();
    const before = { ...localStorage };
    act(() => { fireEvent.click(screen.getByText('focus i9 in p2')); });
    const after = { ...localStorage };
    delete (before as Record<string, unknown>)['agenfk_project_id'];
    delete (after as Record<string, unknown>)['agenfk_project_id'];
    delete (after as Record<string, unknown>)['agenfk_project_last_used'];
    expect(after).toEqual(before);
  });
});


describe('creating a card from the sidebar', () => {
  it('starts with nothing requested', () => {
    renderProbe();
    expect(screen.getByTestId('new-item').textContent).toBe('none');
  });

  it('switches to the project the card belongs in', () => {
    // Creating from a project row must open the draft in THAT project, not in
    // whichever one happened to be selected.
    renderProbe();
    act(() => { fireEvent.click(screen.getByText('new in p2')); });
    expect(screen.getByTestId('active').textContent).toBe('p2');
  });

  it('asking twice fires twice', () => {
    // Dismiss the draft, click + again: a plain flag would compare equal and
    // the second click would do nothing.
    renderProbe();
    act(() => { fireEvent.click(screen.getByText('new in p2')); });
    const first = screen.getByTestId('new-item').textContent;
    act(() => { fireEvent.click(screen.getByText('new in p2 again')); });
    expect(screen.getByTestId('new-item').textContent).not.toBe(first);
  });

  it('does not persist the request', () => {
    // Same correction as above: 'agenfk_new_item' is a key nobody uses, so the
    // old assertion was vacuous. Snapshot everything.
    renderProbe();
    const before = { ...localStorage };
    act(() => { fireEvent.click(screen.getByText('new in p2')); });
    const after = { ...localStorage };
    delete (before as Record<string, unknown>)['agenfk_project_id'];
    delete (after as Record<string, unknown>)['agenfk_project_id'];
    delete (after as Record<string, unknown>)['agenfk_project_last_used'];
    expect(after).toEqual(before);
  });
});

describe('what counts as USING a project', () => {
  // Corrected after use. The stamp used to happen on setActiveProjectId, which
  // fires when you merely OPEN a project — so "last used" meant "last looked
  // at", and clicking through three projects to see what was in them reordered
  // all three under the cursor.
  //
  // Worse than the jumpiness: if everything you glance at rises, the ordering
  // stops telling you where you WORK, which is the only reason it exists.

  it('does not stamp a project just for opening it', () => {
    renderProbe();
    act(() => { fireEvent.click(screen.getByText('pick p2')); });
    expect(readLastUsed()['p2'], 'merely opening a project moved it up the list').toBeUndefined();
  });

  it('does not stamp the project restored at launch', () => {
    // Restoring a session is not working in it either.
    localStorage.setItem('agenfk_project_id', 'p-remembered');
    renderProbe();
    expect(readLastUsed()['p-remembered']).toBeUndefined();
  });

  it('stamps when a card is created in it', () => {
    // An action, not navigation.
    renderProbe();
    act(() => { fireEvent.click(screen.getByText('new in p2')); });
    expect(readLastUsed()['p2']).toBeDefined();
  });

  it('still switches project when a card is created there', () => {
    renderProbe();
    act(() => { fireEvent.click(screen.getByText('new in p2')); });
    expect(screen.getByTestId('active').textContent).toBe('p2');
  });

  it('ranks by the most recent ACTION, not the most recent look', () => {
    renderProbe();
    act(() => { fireEvent.click(screen.getByText('new in p2')); });
    const worked = readLastUsed()['p2'];
    // Looking at another project afterwards must not outrank the one worked in.
    act(() => { fireEvent.click(screen.getByText('pick p3')); });
    expect(readLastUsed()['p3']).toBeUndefined();
    expect(readLastUsed()['p2']).toBe(worked);
  });
});
