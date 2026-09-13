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
import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';

const STORAGE_KEY = 'agenfk_project_id';

interface ActiveProjectValue {
  activeProjectId: string | null;
  setActiveProjectId: (id: string | null) => void;
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

  const setActiveProjectId = useCallback((id: string | null) => {
    setState(id);
    try {
      if (id) localStorage.setItem(STORAGE_KEY, id);
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Private mode or a full quota — losing the memory of which project was
      // open is a papercut, not a reason to fail the switch.
    }
  }, []);

  // Memoised because KanbanBoard is a very large consumer: a fresh object each
  // render would re-render the whole board on any parent update.
  const value = useMemo(
    () => ({ activeProjectId, setActiveProjectId }),
    [activeProjectId, setActiveProjectId],
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
