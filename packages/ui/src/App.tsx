import { KanbanBoard } from './components/KanbanBoard'
import { SocketProvider } from './SocketContext'

function App() {
  return (
    <SocketProvider>
      <div className="bg-canvas min-h-screen font-sans transition-colors duration-300">
        <main>
          <KanbanBoard />
        </main>
      </div>
    </SocketProvider>
  )
}

export default App
