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
  /** Start a new card in a project, from outside the board. */
  requestNewItem: (projectId: string) => void;
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
  const nonce = useRef(0);

  // Mirrors the state so the callback can tell a real switch from a repeat
  // without depending on it. `project_switched` fires on every agent write and
  // calls this unconditionally, so without the comparison an agent touching a
  // project would reorder the user's sidebar — the opposite of what "last used
  // by you" means — and rewrite up to 50 storage entries each time.
  const currentIdRef = useRef<string | null>(activeProjectId);

  const setActiveProjectId = useCallback((id: string | null) => {
    const changed = id !== currentIdRef.current;
    currentIdRef.current = id;
    setState(id);
    // Deliberately NOT stamped here. Opening a project is navigation, and
    // stamping it made "last used" mean "last looked at": clicking through
    // three projects to see what was in them reordered all three under the
    // cursor, and the ordering stopped saying where the user actually works.
    // The stamp belongs on ACTIONS — see markProjectWorked below.
    void changed;
    try {
      if (id) localStorage.setItem(STORAGE_KEY, id);
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Private mode or a full quota — losing the memory of which project was
      // open is a papercut, not a reason to fail the switch.
    }
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

  const requestNewItem = useCallback((projectId: string) => {
    // Asking for a card in a project is work, so it stamps — unlike opening it.
    if (projectId) touchProjectUsed(projectId);
    // The draft belongs to the project whose row was clicked, not to whichever
    // one happened to be selected.
    setActiveProjectId(projectId);
    nonce.current += 1;
    setNewItemRequest(`${projectId}#${nonce.current}`);
  }, [setActiveProjectId]);

  // Memoised because KanbanBoard is a very large consumer: a fresh object each
  // render would re-render the whole board on any parent update.
  const value = useMemo(
    () => ({ activeProjectId, setActiveProjectId, focusedItemId, focusItem, newItemRequest, requestNewItem, markProjectWorked }),
    [activeProjectId, setActiveProjectId, focusedItemId, focusItem, newItemRequest, requestNewItem, markProjectWorked],
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
