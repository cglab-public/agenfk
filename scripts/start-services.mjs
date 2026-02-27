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
    return path.join(agenfkDir, 'db.json');
}
const dbPath = resolveDbPath();

const API_PORT = process.env.AGENFK_PORT || '3000';
const UI_PORT = process.env.VITE_PORT || '5173';

if (!fs.existsSync(agenfkDir)) {
    fs.mkdirSync(agenfkDir, { recursive: true });
}

console.log(`Starting API Server on port ${API_PORT}...`);
const apiLogPath = path.join(agenfkDir, 'api.log');
const apiLog = fs.openSync(apiLogPath, 'w');
const apiProcess = spawn('node', [path.join(rootDir, 'packages/server/dist/server.js')], {
    env: { ...process.env, AGENFK_DB_PATH: dbPath, AGENFK_PORT: API_PORT, VITE_PORT: UI_PORT },
    detached: true,
    stdio: ['ignore', apiLog, apiLog]
});
apiProcess.unref();

console.log(`Starting UI on port ${UI_PORT}...`);
const uiLogPath = path.join(agenfkDir, 'ui.log');
const uiLog = fs.openSync(uiLogPath, 'w');
const isMinGW = !!(process.env.MSYSTEM || process.env.MINGW_PREFIX);
const npmCmd = (os.platform() === 'win32' && !isMinGW) ? 'npm.cmd' : 'npm';
const uiProcess = spawn(npmCmd, ['run', 'dev'], {
    cwd: path.join(rootDir, 'packages/ui'),
    env: { ...process.env, VITE_PORT: UI_PORT, VITE_API_URL: `http://localhost:${API_PORT}` },
    detached: true,
    stdio: ['ignore', uiLog, uiLog],
    shell: true
});
uiProcess.unref();

console.log("Services started in background.");
console.log(`API: http://localhost:${API_PORT}`);
console.log("Database: " + dbPath);
console.log("Logs: " + path.join(agenfkDir, '*.log'));

// Simple wait for UI
console.log("Waiting for UI to be ready...");
let uiUrl = `http://localhost:${UI_PORT}`;
for (let i = 0; i < 15; i++) {
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

const openCmd = process.platform === 'win32' ? 'start' : (process.platform === 'darwin' ? 'open' : 'xdg-open');
spawn(openCmd, [uiUrl], { detached: true, stdio: 'ignore', shell: true }).unref();

process.exit(0);
