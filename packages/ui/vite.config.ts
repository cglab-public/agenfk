import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { homedir } from 'os'

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8'))

// If VITE_API_URL is not explicitly set, fall back to the API port persisted by
// the server at ~/.agenfk/server-port (the API auto-selects the closest free
// port and writes it there). Default to localhost:3000 if neither is present.
function resolveApiUrl(): string {
  if (process.env.VITE_API_URL) return process.env.VITE_API_URL
  try {
    const port = readFileSync(resolve(homedir(), '.agenfk', 'server-port'), 'utf8').trim()
    if (port) return `http://localhost:${port}`
  } catch { /* file not yet written */ }
  return 'http://localhost:3000'
}

const apiUrl = resolveApiUrl()
process.env.VITE_API_URL = apiUrl

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    __AGENFK_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    port: parseInt(process.env.VITE_PORT || '5173'),
  },
  preview: {
    port: parseInt(process.env.VITE_PORT || '5173'),
  },
})
