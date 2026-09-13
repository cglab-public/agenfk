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

function Probe() {
  const { activeProjectId, setActiveProjectId } = useActiveProject();
  return (
    <div>
      <span data-testid="active">{activeProjectId ?? 'none'}</span>
      <button onClick={() => setActiveProjectId('p2')}>pick p2</button>
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
