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
/*
 * 24a7b899 - the board's lifecycle is the server's: nothing else serves it.
 * The vite-preview fallback that ran here when there was no build could never
 * work (preview serves that same build), and a second process is one more thing
 * a restart can leave down. With no build the API still runs, and says so.
 */

const apiLogPath = path.join(agenfkDir, 'api.log');
const apiLog = fs.openSync(apiLogPath, 'w');
const apiProcess = spawn('node', [path.join(rootDir, 'packages/server/dist/server.js')], {
    env: {
        ...process.env,
        AGENFK_DB_PATH: dbPath,
        AGENFK_PORT: REQUESTED_API_PORT,
        ...(servesUi ? { AGENFK_SERVE_UI: uiDist } : {}),
    },
    detached: true,
    stdio: ['ignore', apiLog, apiLog],
    windowsHide: true
});
apiProcess.unref();

let API_PORT = REQUESTED_API_PORT;
let reported = false;
for (let i = 0; i < 30; i++) {
    if (fs.existsSync(SERVER_PORT_FILE)) {
        try {
            const persisted = fs.readFileSync(SERVER_PORT_FILE, 'utf8').trim();
            if (persisted) { API_PORT = persisted; reported = true; break; }
        } catch { /* ignore */ }
    }
    await new Promise(r => setTimeout(r, 500));
}

// A vite URL an older install left behind would send `agenfk ui` to a dead port.
try { fs.unlinkSync(path.join(agenfkDir, 'ui.log')); } catch { /* nothing to remove */ }
const uiUrl = `http://localhost:${API_PORT}`;
// e04dac92: one line - where the board is and where the logs are. Anything else is a warning.
const YELLOW = '\x1b[33m', GREEN = '\x1b[32m', NC = '\x1b[0m';
if (!reported) {
    console.log(`${YELLOW}⚠ The AgEnFK server started but has not reported its port yet - see ${apiLogPath}${NC}`);
} else {
    console.log(`${GREEN}✓ AgEnFK running - ${servesUi ? 'board' : 'API'} at ${uiUrl} (logs: ${agenfkDir})${NC}`);
}
if (reported && API_PORT !== REQUESTED_API_PORT) {
    console.log(`${YELLOW}⚠ Port ${REQUESTED_API_PORT} was unavailable, so the server took ${API_PORT}${NC}`);
}
if (!servesUi) {
    console.log(`${YELLOW}⚠ No built board at ${uiDist}: the API runs without it. Build it with: npm run build -w packages/ui${NC}`);
}

// AGENFK_NO_OPEN_BROWSER gates the auto-open so fleet-driven restarts
// (agenfk restart --quiet) don't surface a new browser tab.
if (process.env.AGENFK_NO_OPEN_BROWSER || !servesUi) {
    process.exit(0);
}

if (process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', '', uiUrl], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
} else {
    const openCmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawn(openCmd, [uiUrl], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

process.exit(0);
