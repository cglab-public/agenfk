import React from 'react'
import { KanbanBoard } from './components/KanbanBoard'
import { AppShell } from './components/AppShell'
import { SocketProvider } from './SocketContext'
import { isDesktop } from './desktop'
import { ActiveProjectProvider } from './ActiveProject'

function App() {
  // One codebase, two shells. In a browser this is the board it has always
  // been; only the Electron app — which announces itself through the preload
  // bridge — gets the sidebar, tabs and status bar around it (CGLAB-168).
  const board = <KanbanBoard />

  /*
   * Tell the stylesheet which shell it is in (CGLAB-189).
   *
   * The no-scroll rule for the window has to reach the document element, and
   * a component cannot style that. Stamped here rather than guessed in CSS,
   * because `isDesktop()` reads the preload bridge and no media query can.
   *
   * The stamp is what keeps the rule OFF the browser, where the board is a
   * page that scrolls and a global version of it hid four of five columns
   * with no way to reach them.
   */
  React.useEffect(() => {
    if (!isDesktop()) return;
    const root = document.documentElement;
    root.dataset.shell = 'desktop';
    /*
     * The other half, and the one CSS cannot do. `overflow: hidden` stops the
     * USER scrolling; it does not stop `scrollIntoView`, which the board calls
     * to reveal a card. Measured: that moved the document 386px and then
     * nothing could move it back - no scrollbar, no wheel, and
     * overscroll-behavior killed the gesture. The ceiling alone turned a
     * recoverable annoyance into an unrecoverable one.
     *
     * Listening rather than overriding scrollIntoView: any future caller gets
     * the same guarantee without knowing this exists, and a pane that scrolls
     * INSIDE itself never reaches this handler because the document never
     * moves.
     */
    const pin = (): void => {
      if (window.scrollY !== 0 || window.scrollX !== 0) window.scrollTo(0, 0);
    };
    window.addEventListener('scroll', pin, { passive: true });
    return () => {
      window.removeEventListener('scroll', pin);
      delete root.dataset.shell;
    };
  }, [])

  return (
    <ActiveProjectProvider>
      <SocketProvider>
        {isDesktop() ? (
          <AppShell>{board}</AppShell>
        ) : (
          <div className="bg-canvas min-h-screen font-sans transition-colors duration-300">
            <main>{board}</main>
          </div>
        )}
      </SocketProvider>
    </ActiveProjectProvider>
  )
}

export default App
