import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const agenfkDir = path.join(rootDir, '.agenfk');
const dbPath = process.env.AGENFK_DB_PATH || path.join(agenfkDir, 'db.json');

if (!fs.existsSync(agenfkDir)) {
    fs.mkdirSync(agenfkDir, { recursive: true });
}

console.log("Starting API Server on port 3000...");
const apiLogPath = path.join(agenfkDir, 'api.log');
const apiLog = fs.openSync(apiLogPath, 'a');
const apiProcess = spawn('node', [path.join(rootDir, 'packages/server/dist/server.js')], {
    env: { ...process.env, AGENFK_DB_PATH: dbPath },
    detached: true,
    stdio: ['ignore', apiLog, apiLog]
});
apiProcess.unref();

console.log("Starting UI...");
const uiLogPath = path.join(agenfkDir, 'ui.log');
const uiLog = fs.openSync(uiLogPath, 'a');
const npmCmd = os.platform() === 'win32' ? 'npm.cmd' : 'npm';
const uiProcess = spawn(npmCmd, ['run', 'dev'], {
    cwd: path.join(rootDir, 'packages/ui'),
    detached: true,
    stdio: ['ignore', uiLog, uiLog],
    shell: true
});
uiProcess.unref();

console.log("Services started in background.");
console.log("API: http://localhost:3000");
console.log("Database: " + dbPath);
console.log("Logs: " + path.join(agenfkDir, '*.log'));

// Simple wait for UI
console.log("Waiting for UI to be ready...");
let uiUrl = 'http://localhost:5173';
for (let i = 0; i < 15; i++) {
    if (fs.existsSync(uiLogPath)) {
        const content = fs.readFileSync(uiLogPath, 'utf8');
        const match = content.match(/http:\/\/localhost:[0-9]+/);
        if (match) {
            uiUrl = match[0];
            break;
        }
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
}

console.log("UI available at: " + uiUrl);

// Detect WSL
const isWSL = () => {
    try {
        const version = fs.readFileSync('/proc/version', 'utf8').toLowerCase();
        return version.includes('microsoft') || version.includes('wsl');
    } catch (e) {
        return false;
    }
};

let openCmd = process.platform === 'win32' ? 'start' : (process.platform === 'darwin' ? 'open' : 'xdg-open');

if (process.platform === 'linux' && isWSL()) {
    // WSL2: Use powershell.exe to start the browser on host.
    spawn('powershell.exe', ['-c', 'start', uiUrl], { detached: true, stdio: 'ignore' }).unref();
} else {
    spawn(openCmd, [uiUrl], { detached: true, stdio: 'ignore', shell: true }).unref();
}

process.exit(0);
