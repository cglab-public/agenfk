import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { homedir } from 'os'

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8'))

// The browser uses same-origin API URLs by default. During local development
// and preview, proxy those requests to the API port persisted by the server.
function resolveApiProxyTarget(): string {
  try {
    const port = readFileSync(resolve(homedir(), '.agenfk', 'server-port'), 'utf8').trim()
    if (port) return `http://localhost:${port}`
  } catch { /* file not yet written */ }
  return 'http://localhost:3000'
}

const apiProxyTarget = resolveApiProxyTarget()
const proxy = {
  '^/(api|version|db|backup|projects|flows|prs|token-events|registry|items|internal|jira|github|releases)(/|\\?|$)': {
    target: apiProxyTarget,
    changeOrigin: true,
  },
  '/socket.io': {
    target: apiProxyTarget,
    changeOrigin: true,
    ws: true,
  },
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    __AGENFK_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    port: parseInt(process.env.VITE_PORT || '5173'),
    proxy,
  },
  preview: {
    port: parseInt(process.env.VITE_PORT || '5173'),
    proxy,
  },
})
