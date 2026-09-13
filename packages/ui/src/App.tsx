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
