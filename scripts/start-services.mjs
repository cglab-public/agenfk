import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const agenfkDir = path.join(rootDir, '.agenfk');

// Resolve dbPath: env var → ~/.agenfk/config.json → default
function resolveDbPath() {
    if (process.env.AGENFK_DB_PATH) return process.env.AGENFK_DB_PATH;
    const configPath = path.join(os.homedir(), '.agenfk', 'config.json');
    if (fs.existsSync(configPath)) {
        try {
            const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            if (cfg.dbPath) return cfg.dbPath;
        } catch (e) {}
    }
    return path.join(agenfkDir, 'db.sqlite');
}
const dbPath = resolveDbPath();

const REQUESTED_API_PORT = process.env.AGENFK_PORT || '3000';
const UI_PORT = process.env.VITE_PORT || '5173';
const SERVER_PORT_FILE = path.join(os.homedir(), '.agenfk', 'server-port');

if (!fs.existsSync(agenfkDir)) {
    fs.mkdirSync(agenfkDir, { recursive: true });
}

try { fs.unlinkSync(SERVER_PORT_FILE); } catch { /* ignore */ }

/*
 * ONE ORIGIN (CGLAB-165). The API serves the built UI when there is one, so
 * there is a single port for both - and, load-bearingly, so the DESKTOP can
 * adopt this server. The desktop loads its window from the server it adopts and
 * refuses one that serves no HTML (`servesUiBundle`), which is exactly what a
 * bare API is; with the UI on its own vite port the app had nothing to adopt
 * and fell back to a browser. The server side was already built for this
 * (AGENFK_SERVE_UI); only this script still started vite separately.
 */
const uiDist = path.join(rootDir, 'packages/ui', 'dist');
const servesUi = fs.existsSync(path.join(uiDist, 'index.html'));

console.log(`Starting API Server (requested port ${REQUESTED_API_PORT})${servesUi ? ' with the built UI' : ''}...`);
const apiLogPath = path.join(agenfkDir, 'api.log');
const apiLog = fs.openSync(apiLogPath, 'w');
const apiProcess = spawn('node', [path.join(rootDir, 'packages/server/dist/server.js')], {
    env: {
        ...process.env,
        AGENFK_DB_PATH: dbPath,
        AGENFK_PORT: REQUESTED_API_PORT,
        VITE_PORT: UI_PORT,
        ...(servesUi ? { AGENFK_SERVE_UI: uiDist } : {}),
    },
    detached: true,
    stdio: ['ignore', apiLog, apiLog]
});
apiProcess.unref();

let API_PORT = REQUESTED_API_PORT;
for (let i = 0; i < 30; i++) {
    if (fs.existsSync(SERVER_PORT_FILE)) {
        try {
            const persisted = fs.readFileSync(SERVER_PORT_FILE, 'utf8').trim();
            if (persisted) { API_PORT = persisted; break; }
        } catch { /* ignore */ }
    }
    await new Promise(r => setTimeout(r, 500));
}
if (API_PORT !== REQUESTED_API_PORT) {
    console.log(`API Server bound to port ${API_PORT} (requested ${REQUESTED_API_PORT} was unavailable).`);
}

const uiLogPath = path.join(agenfkDir, 'ui.log');
const isMinGW = !!(process.env.MSYSTEM || process.env.MINGW_PREFIX);
const npmCmd = (os.platform() === 'win32' && !isMinGW) ? 'npm.cmd' : 'npm';
if (servesUi) {
    // Remove a STALE vite URL: `agenfk ui` reads this log, and a 5173 left over
    // from a previous run would point at a port nothing is serving any more.
    try { fs.unlinkSync(uiLogPath); } catch { /* nothing to remove */ }
    console.log(`UI served by the API on port ${API_PORT} (no separate vite).`);
} else {
    console.log(`No built UI found; starting vite preview on port ${UI_PORT}...`);
    const uiLog = fs.openSync(uiLogPath, 'w');
    const uiProcess = spawn(npmCmd, ['run', 'preview'], {
        cwd: path.join(rootDir, 'packages/ui'),
        env: { ...process.env, VITE_PORT: UI_PORT, VITE_API_URL: `http://localhost:${API_PORT}` },
        detached: true,
        stdio: ['ignore', uiLog, uiLog],
        shell: os.platform() === 'win32', // .cmd scripts need shell on Windows (MinGW + native)
    });
    uiProcess.unref();
}

console.log("Services started in background.");
console.log(`API: http://localhost:${API_PORT}`);
console.log("Database: " + dbPath);
console.log("Logs: " + path.join(agenfkDir, '*.log'));

// Simple wait for UI
console.log("Waiting for UI to be ready...");
// The API's own port when it serves the UI; the vite port otherwise.
let uiUrl = servesUi ? `http://localhost:${API_PORT}` : `http://localhost:${UI_PORT}`;
for (let i = 0; i < 15 && !servesUi; i++) {
    if (fs.existsSync(uiLogPath)) {
        const content = fs.readFileSync(uiLogPath, 'utf8');
        const matches = content.match(/http:\/\/localhost:[0-9]+/g);
        if (matches) {
            uiUrl = matches[matches.length - 1];
            break;
        }
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
}

console.log("UI available at: " + uiUrl);

// AGENFK_NO_OPEN_BROWSER gates the auto-open so fleet-driven restarts
// (agenfk restart --quiet) don't surface a new browser tab.
if (process.env.AGENFK_NO_OPEN_BROWSER) {
    process.exit(0);
}

if (process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', '', uiUrl], { detached: true, stdio: 'ignore' }).unref();
} else {
    const openCmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawn(openCmd, [uiUrl], { detached: true, stdio: 'ignore' }).unref();
}

process.exit(0);
