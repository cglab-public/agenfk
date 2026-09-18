/**
 * Which project is open (CGLAB-168).
 *
 * This lived as `useState` inside KanbanBoard, which was fine while the board
 * was the only thing on screen. The desktop sidebar both shows the active
 * project and switches it, and two components each holding their own copy is
 * the classic way to end up with a sidebar and a board disagreeing about what
 * you are looking at. So it moves up, with the rules it already had: a
 * `?project=` deep link wins over the remembered choice, and every change is
 * remembered for next launch.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { touchProjectUsed } from './sidebarPrefs';
import type { AgEnFKItem } from './types';

const STORAGE_KEY = 'agenfk_project_id';

interface ActiveProjectValue {
  activeProjectId: string | null;
  setActiveProjectId: (id: string | null) => void;
  /**
   * The card to navigate to, as `<itemId>#<nonce>`.
   *
   * The nonce is what makes clicking the same sidebar row twice work: a plain
   * id compares equal to the last one, so the board would ignore the second
   * click and never scroll back to it.
   */
  /** Record real work in a project, for the sidebar's "Last used" ordering. */
  markProjectWorked: (projectId: string) => void;
  focusedItemId: string | null;
  /** Go to a card: switch to its project if needed, then point the board at it. */
  focusItem: (itemId: string, projectId?: string) => void;
  /**
   * A request to start a new card, as `<projectId>#<nonce>`.
   *
   * Nonced for the same reason as the focus: dismiss the draft, click + again,
   * and a plain value would compare equal and the board would ignore it.
   */
  newItemRequest: string | null;
  /**
   * The words the draft should open with, when the caller had some.
   *
   * Kept BESIDE `newItemRequest` rather than folded into it: that value is a
   * parsed string (`<projectId>#<nonce>`) with two readers, and widening its
   * shape to carry a title would have made every one of them parse a title out
   * of a project id. Overwritten by the next request — including with `null`
   * when that request carries no seed — which is what keeps a stale title from
   * reaching a draft opened by another door.
   */
  newItemTitle: string | null;
  /**
   * Start a new card in a project, from outside the board.
   *
   * `seedTitle` is for callers that already hold the words — the card picker's
   * empty state hands over whatever was typed into its search box, because a
   * phrase that matched no card is usually the title of the card that does not
   * exist yet, and asking for it a second time is the friction being removed.
   */
  requestNewItem: (projectId: string, seedTitle?: string) => void;
  /**
   * A request to open a terminal ON a card, from the board (CGLAB-176).
   *
   * The reverse direction of `newItemRequest`: that one carries a request from
   * the shell INTO the board, this one carries one from the board OUT to the
   * shell, which owns the sessions. Nonced for the same reason — close the
   * terminal, click the card's button again, and a plain value would compare
   * equal and nothing would happen.
   *
   * Carries the ITEM rather than its id because the shell needs the title and
   * the agent to put up the open dialog, and the board already has both. An id
   * would make the shell look up a card the board is holding.
   */
  terminalRequest: { item: AgEnFKItem; nonce: number } | null;
  /** Open a terminal on a card, from the board. */
  requestTerminalFor: (item: AgEnFKItem) => void;
}

const ActiveProjectContext = createContext<ActiveProjectValue | null>(null);

function initialProjectId(): string | null {
  // `agenfk ui --open <id>&project=<pid>` must land where the caller asked,
  // not on whatever happened to be open here last.
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('project');
    if (fromUrl) return fromUrl;
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function ActiveProjectProvider({ children }: { children: React.ReactNode }) {
  const [activeProjectId, setState] = useState<string | null>(initialProjectId);
  // Not persisted: this is a navigation, not a preference. Restoring it on
  // launch would yank the board to wherever you happened to click last time.
  const [focusedItemId, setFocusedItemId] = useState<string | null>(null);
  const [newItemRequest, setNewItemRequest] = useState<string | null>(null);
  const [newItemTitle, setNewItemTitle] = useState<string | null>(null);
  const [terminalRequest, setTerminalRequest] = useState<{ item: AgEnFKItem; nonce: number } | null>(null);
  const nonce = useRef(0);

  /**
   * Navigation only. Deliberately does NOT record the project as used.
   *
   * It used to, and that made "last used" mean "last looked at": clicking
   * through three projects to see what was in them reordered all three under
   * the cursor. Worse, `project_switched` fires on every agent write, so an
   * agent touching a project reordered the user's sidebar.
   *
   * What counts as working is in `markProjectWorked`, and the callers that
   * have earned it are the ones that start something: creating a card, opening
   * a terminal on one.
   */
  const setActiveProjectId = useCallback((id: string | null) => {
    try {
      if (id) localStorage.setItem(STORAGE_KEY, id);
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Private mode or a full quota — losing the memory of which project was
      // open is a papercut, not a reason to fail the switch.
    }
    setState(id);
  }, []);

  /**
   * Record that real work happened in a project.
   *
   * Actions only: creating a card, advancing a step, opening a terminal on a
   * card. Never navigation — see setActiveProjectId. The server's
   * Project.updatedAt cannot serve here because it moves on rename and
   * reconfigure and not on work, which is why this is local in the first place.
   */
  const markProjectWorked = useCallback((projectId: string) => {
    if (projectId) touchProjectUsed(projectId);
  }, []);

  const focusItem = useCallback((itemId: string, projectId?: string) => {
    // The board can only find a card that belongs to the project it is
    // showing, so bring the project along.
    if (projectId) setActiveProjectId(projectId);
    nonce.current += 1;
    setFocusedItemId(`${itemId}#${nonce.current}`);
  }, [setActiveProjectId]);

  const requestNewItem = useCallback((projectId: string, seedTitle?: string) => {
    // Asking for a card in a project is work, so it stamps — unlike opening it.
    if (projectId) touchProjectUsed(projectId);
    // The draft belongs to the project whose row was clicked, not to whichever
    // one happened to be selected.
    setActiveProjectId(projectId);
    nonce.current += 1;
    // Set the title FIRST: both land in the same batch, and the board reads the
    // title inside the effect keyed on the request. Writing them in the other
    // order is the same render either way — but the order that matches the read
    // is the one that survives someone later splitting the effect.
    setNewItemTitle(seedTitle?.trim() || null);
    setNewItemRequest(`${projectId}#${nonce.current}`);
  }, [setActiveProjectId]);

  /**
   * Ask the shell for a terminal on a card.
   *
   * Deliberately does NOT stamp the project as worked here, even though opening
   * a terminal is the strongest "working here" signal the app has. The shell's
   * `requestTerminal` already stamps it, and this route ends there — stamping
   * in both places would be the double-counting `setActiveProjectId` was fixed
   * for, just moved one level up.
   */
  const requestTerminalFor = useCallback((item: AgEnFKItem) => {
    nonce.current += 1;
    setTerminalRequest({ item, nonce: nonce.current });
  }, []);

  // Memoised because KanbanBoard is a very large consumer: a fresh object each
  // render would re-render the whole board on any parent update.
  const value = useMemo(
    () => ({ activeProjectId, setActiveProjectId, focusedItemId, focusItem, newItemRequest, newItemTitle, requestNewItem, markProjectWorked, terminalRequest, requestTerminalFor }),
    [activeProjectId, setActiveProjectId, focusedItemId, focusItem, newItemRequest, newItemTitle, requestNewItem, markProjectWorked, terminalRequest, requestTerminalFor],
  );

  return (
    <ActiveProjectContext.Provider value={value}>
      {children}
    </ActiveProjectContext.Provider>
  );
}

/**
 * Throws without a provider, unlike useSocketEvent. A missing socket costs you
 * live updates; a missing project state would leave the board and the sidebar
 * silently showing different things, which is worse than a loud failure.
 */
export function useActiveProject(): ActiveProjectValue {
  const value = useContext(ActiveProjectContext);
  if (!value) throw new Error('useActiveProject must be used within an ActiveProjectProvider');
  return value;
}
