import fs from 'fs/promises';
import { existsSync, chmodSync, writeFileSync, readdirSync, copyFileSync, readFileSync, renameSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync, execSync } from 'child_process';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import readline from 'readline';

const GREEN = '\x1b[32m';
const BLUE = '\x1b[34m';
const YELLOW = '\x1b[33m';
const NC = '\x1b[0m';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const agenfkHome = path.join(os.homedir(), '.agenfk');

const isMinGW = !!(process.env.MSYSTEM || process.env.MINGW_PREFIX || (os.platform() === 'win32' && process.env.SHELL?.includes('bash')));

function getCliCommand(name) {
    return os.platform() === 'win32' && !isMinGW ? `${name}.cmd` : name;
}

// Returns the platform-appropriate path for Cursor's global mcp.json.
function getCursorMcpPath() {
    if (os.platform() === 'win32') {
        const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
        return path.join(appData, 'Cursor', 'mcp.json');
    } else if (os.platform() === 'darwin') {
        return path.join(os.homedir(), '.cursor', 'mcp.json');
    } else {
        return path.join(os.homedir(), '.config', 'cursor', 'mcp.json');
    }
}

// Converts a MinGW POSIX path (/c/Users/...) to a Win32 path (C:\Users\...)
// so that native Windows apps (like Cursor) can resolve it correctly.
function toWindowsPath(p) {
    if (isMinGW && /^\/[a-zA-Z]\//.test(p)) {
        return p[1].toUpperCase() + ':' + p.slice(2).replace(/\//g, '\\');
    }
    return p;
}

// Returns the platform-appropriate directory for Cursor's global rules (.mdc files).
function getCursorRulesDir() {
    if (os.platform() === 'win32') {
        const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
        return path.join(appData, 'Cursor', 'rules');
    } else if (os.platform() === 'darwin') {
        return path.join(os.homedir(), '.cursor', 'rules');
    } else {
        return path.join(os.homedir(), '.config', 'cursor', 'rules');
    }
}

function ask(rl, question) {
    return new Promise(resolve => rl.question(question, resolve));
}

async function run() {
    console.log(`${BLUE}=== AgenFK Framework Installation ===${NC}`);

    const debuglog = process.argv.includes('--debuglog');
    const onlyPlatform = process.argv.find(arg => arg.startsWith('--only='))?.split('=')[1];
    const skipPlatform = process.argv.find(arg => arg.startsWith('--skip='))?.split('=')[1];

    const debugLog = debuglog ? (...args) => console.log(`${YELLOW}[DEBUG]${NC}`, ...args) : () => {};

    if (debuglog) {
        debugLog('=== AgenFK Install Debug Log ===');
        debugLog('argv:', process.argv.join(' '));
        debugLog('cwd:', process.cwd());
        debugLog('rootDir:', rootDir);
        debugLog('platform:', os.platform(), '| arch:', os.arch(), '| node:', process.version);
        debugLog('WSL_DISTRO_NAME:', process.env.WSL_DISTRO_NAME || '(not set)');
        debugLog('WSL_INTEROP:', process.env.WSL_INTEROP || '(not set)');
        debugLog('AGENFK_DB_PATH env:', process.env.AGENFK_DB_PATH || '(not set)');
        debugLog('onlyPlatform:', onlyPlatform || '(none)');
        const agenfkConfigPath_ = path.join(agenfkHome, 'config.json');
        debugLog('~/.agenfk/config.json path:', agenfkConfigPath_);
        if (existsSync(agenfkConfigPath_)) {
            try {
                const cfg = readFileSync(agenfkConfigPath_, 'utf8');
                debugLog('~/.agenfk/config.json contents:', cfg.trim());
            } catch (e) {
                debugLog('~/.agenfk/config.json read error:', e.message);
            }
        } else {
            debugLog('~/.agenfk/config.json: NOT FOUND');
        }
        // Check if an agenfk server is already reachable on the default port
        const serverPort = process.env.AGENFK_PORT || '3000';
        const serverCheck = spawnSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '1', `http://localhost:${serverPort}/`], { encoding: 'utf8' });
        const serverReachable = serverCheck.status === 0 && serverCheck.stdout.trim() !== '000';
        debugLog(`server on localhost:${serverPort}:`, serverReachable ? `REACHABLE (HTTP ${serverCheck.stdout.trim()})` : 'NOT REACHABLE');
    }

    function shouldRun(platform) {
        if (onlyPlatform) return onlyPlatform.toLowerCase() === platform.toLowerCase();
        if (skipPlatform) return skipPlatform.toLowerCase() !== platform.toLowerCase();
        return true;
    }

    // 1. Verify pre-built dist bundles
    const requiredDists = [
        'packages/core/dist',
        'packages/storage-json/dist',
        'packages/storage-sqlite/dist',
        'packages/telemetry/dist',
        'packages/cli/dist',
        'packages/server/dist',
    ];

    // Remove stale TypeScript source directories from installed packages.
    // The distributable tarball only ships pre-built dist/ — any src/ present is from
    // a previous source-based install and must be removed to prevent a future upgrade
    // from accidentally rebuilding from old source instead of using the pre-built dist.
    const staleSrcDirs = [
        'packages/core/src',
        'packages/storage-json/src',
        'packages/storage-sqlite/src',
        'packages/telemetry/src',
        'packages/cli/src',
        'packages/server/src',
        'packages/ui/src',
        'packages/create/src',
    ];
    function cleanStaleSrc() {
        let cleaned = 0;
        for (const d of staleSrcDirs) {
            const fullPath = path.join(rootDir, d);
            if (existsSync(fullPath)) {
                rmSync(fullPath, { recursive: true, force: true });
                cleaned++;
            }
        }
        if (cleaned > 0) console.log(`  Removed ${cleaned} stale source director${cleaned === 1 ? 'y' : 'ies'} (pre-built mode).`);
    }

    // If dists are missing, attempt to re-download the release tarball for this version.
    async function autoHealRedownload() {
        let pkgVersion = '0.0.0';
        try {
            const pkg = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
            pkgVersion = pkg.version || pkgVersion;
        } catch { /* ignore */ }

        const REPO = 'cglab-public/agenfk';
        const tag = `v${pkgVersion}`;
        const url = `https://github.com/${REPO}/releases/download/${tag}/agenfk-dist.tar.gz`;
        const tmpFile = path.join(os.tmpdir(), `agenfk-heal-${Date.now()}.tar.gz`);

        console.log(`${YELLOW}[1/14] Pre-built artifacts missing — auto-heal re-download for ${tag}...${NC}`);
        try {
            // Try curl first
            const curlResult = spawnSync('curl', ['-fsSL', '-o', tmpFile, url], { stdio: 'pipe' });
            if (curlResult.status !== 0) {
                // gh CLI fallback
                const tmpDir = path.dirname(tmpFile);
                const ghResult = spawnSync('gh', ['release', 'download', tag, '--repo', REPO,
                    '--pattern', 'agenfk-dist.tar.gz', '-D', tmpDir, '--clobber'], { stdio: 'pipe' });
                if (ghResult.status !== 0) return false;
                const ghFile = path.join(tmpDir, 'agenfk-dist.tar.gz');
                if (existsSync(ghFile)) renameSync(ghFile, tmpFile);
                else return false;
            }
            spawnSync('tar', ['-xzf', tmpFile, '-C', rootDir], { stdio: 'inherit' });
            console.log(`${GREEN}  Re-download complete.${NC}`);
            return true;
        } catch { return false; } finally {
            if (existsSync(tmpFile)) rmSync(tmpFile, { force: true });
        }
    }

    if (!onlyPlatform) {
        let missingDists = requiredDists.filter(d => !existsSync(path.join(rootDir, d)));

        if (debuglog) {
            debugLog('--- Dist check ---');
            for (const d of requiredDists) {
                const full = path.join(rootDir, d);
                debugLog(`  dist ${d}: ${existsSync(full) ? 'PRESENT' : 'MISSING'}`);
            }
            debugLog('missingDists count:', missingDists.length);
            if (missingDists.length > 0) debugLog('missing:', missingDists.join(', '));
            const presentStaleSrc = staleSrcDirs.filter(d => existsSync(path.join(rootDir, d)));
            debugLog('staleSrcDirs present:', presentStaleSrc.length > 0 ? presentStaleSrc.join(', ') : '(none)');
        }

        if (missingDists.length > 0) {
            debugLog('trigger: missing dists → attempting auto-heal re-download');
            const healed = await autoHealRedownload();
            debugLog('auto-heal result:', healed ? 'SUCCESS' : 'FAILED');
            if (healed) missingDists = requiredDists.filter(d => !existsSync(path.join(rootDir, d)));
            debugLog('missingDists after heal:', missingDists.length);
        }

        if (missingDists.length > 0) {
            console.error(`${YELLOW}Installation failed: pre-built dist bundles are missing and could not be downloaded.`);
            console.error(`  Missing: ${missingDists.join(', ')}`);
            console.error(`  Download the latest release manually from https://github.com/cglab-public/agenfk/releases${NC}`);
            process.exit(1);
        }

        debugLog('decision: all pre-built dists present');
        console.log(`${GREEN}[1/14] Pre-built dist bundles verified.${NC}`);
        cleanStaleSrc();
    } else {
        const missingDists = requiredDists.filter(d => !existsSync(path.join(rootDir, d)));
        if (missingDists.length > 0) {
            debugLog('trigger (onlyPlatform mode): missing dists → attempting re-download');
            const healed = await autoHealRedownload();
            if (!healed || requiredDists.some(d => !existsSync(path.join(rootDir, d)))) {
                console.error(`${YELLOW}Integration install failed: pre-built dist bundles are missing.`);
                console.error(`  Download the latest release from https://github.com/cglab-public/agenfk/releases${NC}`);
                process.exit(1);
            }
        }
    }

    // 2. Generate install-time secret verify token
    if (!onlyPlatform) {
        console.log(`${GREEN}[2/14] Generating secret verify token...${NC}`);
        if (!existsSync(agenfkHome)) {
            await fs.mkdir(agenfkHome, { recursive: true });
        }
        const tokenPath = path.join(agenfkHome, 'verify-token');
        if (!existsSync(tokenPath)) {
            const token = crypto.randomBytes(32).toString('hex');
            await fs.writeFile(tokenPath, token, 'utf8');
            chmodSync(tokenPath, 0o600);
            console.log(`  Generated: ${tokenPath}`);
        } else {
            console.log(`  Token already exists: ${tokenPath}`);
        }
    }

    // 3. Database configuration
    const agenfkConfigPath = path.join(agenfkHome, 'config.json');
    let dbPath = '';

    if (existsSync(agenfkConfigPath)) {
        try {
            const cfg = JSON.parse(readFileSync(agenfkConfigPath, 'utf8'));
            if (cfg.dbPath) {
                dbPath = cfg.dbPath;
                if (!onlyPlatform) console.log(`  Using existing database configuration: ${dbPath}`);
            }
        } catch (e) {}
    }

    if (!dbPath && !onlyPlatform) {
        console.log(`${GREEN}[3/14] Choosing database engine...${NC}`);
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

        let dbType = 'sqlite';
        try {
            const answer = await ask(rl, `  Choose storage engine [json/sqlite] (default: sqlite): `);
            if (answer.trim().toLowerCase() === 'json') dbType = 'json';
        } finally {
            rl.close();
        }

        const dbExtension = dbType === 'sqlite' ? 'db.sqlite' : 'db.json';
        dbPath = path.join(rootDir, '.agenfk', dbExtension);
        console.log(`  Using: ${dbType.toUpperCase()} (${dbPath})`);

        // 3a. Write ~/.agenfk/config.json
        await fs.writeFile(agenfkConfigPath, JSON.stringify({ dbPath, telemetry: true }, null, 2), 'utf8');
        console.log(`  Config written: ${agenfkConfigPath}`);
    } else if (!dbPath && onlyPlatform) {
        // Fallback for onlyPlatform if no config exists
        dbPath = path.join(rootDir, '.agenfk', 'db.sqlite');
    }

    debugLog('dbPath resolved:', dbPath || '(empty — not yet set)');
    debugLog('dbPath file exists:', dbPath ? existsSync(dbPath) : false);

    // 3b. Restore from backup (new install only)
    if (!onlyPlatform) {
        const backupDir = path.join(agenfkHome, 'backup');
        const isNewInstall = !existsSync(dbPath);
        if (isNewInstall && existsSync(backupDir)) {
            const backups = readdirSync(backupDir)
                .filter(f => f.startsWith('agenfk-backup-') && f.endsWith('.json'))
                .sort()
                .reverse();
            if (backups.length > 0) {
                console.log(`\n${YELLOW}  Found ${backups.length} backup(s) in ${backupDir}.${NC}`);
                backups.slice(0, 5).forEach((f, i) => console.log(`  [${i + 1}] ${f}`));
                const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
                try {
                    const ans = await ask(rl2, `  Restore latest backup? [y/N]: `);
                    if (ans.trim().toLowerCase() === 'y') {
                        const migrationPath = path.join(agenfkHome, 'migration.json');
                        copyFileSync(path.join(backupDir, backups[0]), migrationPath);
                        console.log(`  ${GREEN}Backup staged for restore — will be imported on first server start.${NC}`);
                    }
                } finally {
                    rl2.close();
                }
            }
        }
    }

    // 4. Ensure configuration exists
    if (!onlyPlatform) {
        console.log(`${GREEN}[4/14] Initializing configuration...${NC}`);
        const localConfigDir = path.join(rootDir, '.agenfk');
        if (!existsSync(localConfigDir)) {
            spawnSync(process.execPath, [path.join(rootDir, 'packages/cli/bin/agenfk.js'), 'init'], { stdio: 'inherit' });
        }
    }

    // 5. Create start script for UI/API
    if (!onlyPlatform) {
        console.log(`${GREEN}[5/14] Creating background service script (start-services.mjs)...${NC}`);
        const startScriptPath = path.join(rootDir, 'scripts', 'start-services.mjs');
        const serverPath = path.join(rootDir, 'packages', 'server', 'dist', 'index.js');
        const uiDir = path.join(rootDir, 'packages', 'ui');
        
        const startScriptContent = `
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

console.log(\`Starting API Server on port \${API_PORT}...\`);
const apiLogPath = path.join(agenfkDir, 'api.log');
const apiLog = fs.openSync(apiLogPath, 'w');
const apiProcess = spawn('node', [path.join(rootDir, 'packages/server/dist/server.js')], {
    env: { ...process.env, AGENFK_DB_PATH: dbPath, AGENFK_PORT: API_PORT, VITE_PORT: UI_PORT },
    detached: true,
    stdio: ['ignore', apiLog, apiLog]
});
apiProcess.unref();

console.log(\`Starting UI on port \${UI_PORT}...\`);
const uiLogPath = path.join(agenfkDir, 'ui.log');
const uiLog = fs.openSync(uiLogPath, 'w');
const isMinGW = !!(process.env.MSYSTEM || process.env.MINGW_PREFIX);
const npmCmd = (os.platform() === 'win32' && !isMinGW) ? 'npm.cmd' : 'npm';
const uiProcess = spawn(npmCmd, ['run', 'preview'], {
    cwd: path.join(rootDir, 'packages/ui'),
    env: { ...process.env, VITE_PORT: UI_PORT, VITE_API_URL: \`http://localhost:\${API_PORT}\` },
    detached: true,
    stdio: ['ignore', uiLog, uiLog]
});
uiProcess.unref();

console.log("Services started in background.");
console.log(\`API: http://localhost:\${API_PORT}\`);
console.log("Database: " + dbPath);
console.log("Logs: " + path.join(agenfkDir, '*.log'));

// Simple wait for UI
console.log("Waiting for UI to be ready...");
let uiUrl = \`http://localhost:\${UI_PORT}\`;
for (let i = 0; i < 15; i++) {
    if (fs.existsSync(uiLogPath)) {
        const content = fs.readFileSync(uiLogPath, 'utf8');
        const matches = content.match(/http:\\/\\/localhost:[0-9]+/g);
        if (matches) {
            uiUrl = matches[matches.length - 1];
            break;
        }
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
}

console.log("UI available at: " + uiUrl);

if (process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', '', uiUrl], { detached: true, stdio: 'ignore' }).unref();
} else {
    const openCmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawn(openCmd, [uiUrl], { detached: true, stdio: 'ignore' }).unref();
}

process.exit(0);
`;
        await fs.writeFile(startScriptPath, startScriptContent.trim() + '\n', 'utf8');
        console.log(`  Created: ${startScriptPath}`);
    }

    const serverPath = path.join(rootDir, 'packages', 'server', 'dist', 'index.js');

    // 6. Configure Opencode MCP
    if (shouldRun('opencode')) {
        console.log(`${GREEN}[6/14] Configuring Opencode MCP...${NC}`);
        const opencodeConfigPath = path.join(os.homedir(), '.config', 'opencode', 'opencode.json');
        const opencodeInstalled = spawnSync(getCliCommand('opencode'), ['--version'], { stdio: 'ignore' }).status === 0;
        if (existsSync(opencodeConfigPath) || opencodeInstalled) {
            try {
                let config = {};
                if (existsSync(opencodeConfigPath)) {
                    config = JSON.parse(await fs.readFile(opencodeConfigPath, 'utf8'));
                } else {
                    await fs.mkdir(path.dirname(opencodeConfigPath), { recursive: true });
                    console.log(`  Opencode detected but opencode.json missing — creating it.`);
                }
                if (!config.mcp) config.mcp = {};

                config.mcp.agenfk = {
                    type: 'local',
                    enabled: true,
                    command: ['node', serverPath],
                    environment: {
                        NODE_ENV: 'production',
                        AGENFK_DB_PATH: dbPath
                    }
                };

                await fs.writeFile(opencodeConfigPath, JSON.stringify(config, null, 2));
                console.log(`  Written: ${opencodeConfigPath}`);
            } catch (e) {
                console.error('Error updating opencode.json:', e.message);
            }
        } else if (!onlyPlatform) {
            console.log(`Opencode not found. Skipping opencode.json configuration.`);
        }
    }

    // 6b. Configure Cursor MCP
    if (shouldRun('cursor')) {
        console.log(`${GREEN}[6b/14] Configuring Cursor MCP...${NC}`);
        const cursorMcpPath = getCursorMcpPath();
        const cursorConfigDir = path.dirname(cursorMcpPath);
        const cursorCmd = getCliCommand('cursor');
        const cursorInstalled = existsSync(cursorConfigDir) ||
            spawnSync(cursorCmd, ['--version'], { stdio: 'ignore' }).status === 0;
        if (cursorInstalled) {
            try {
                let cursorMcp = {};
                if (existsSync(cursorMcpPath)) {
                    cursorMcp = JSON.parse(await fs.readFile(cursorMcpPath, 'utf8'));
                } else {
                    await fs.mkdir(cursorConfigDir, { recursive: true });
                    console.log(`  Cursor config dir not found — creating it.`);
                }
                if (!cursorMcp.mcpServers) cursorMcp.mcpServers = {};

                // Normalize paths written into the config file: Cursor is a native Windows
                // Electron app and cannot resolve MinGW POSIX paths (/c/Users/...).
                const cursorServerPath = isMinGW ? toWindowsPath(serverPath) : serverPath;
                const cursorDbPath = isMinGW ? toWindowsPath(dbPath) : dbPath;

                cursorMcp.mcpServers.agenfk = {
                    command: 'node',
                    args: [cursorServerPath],
                    env: {
                        NODE_ENV: 'production',
                        AGENFK_DB_PATH: cursorDbPath
                    }
                };

                await fs.writeFile(cursorMcpPath, JSON.stringify(cursorMcp, null, 2));
                console.log(`  Written: ${cursorMcpPath}`);
            } catch (e) {
                console.error('Error updating Cursor mcp.json:', e.message);
            }
        } else if (!onlyPlatform) {
            console.log(`  Cursor not found. Skipping Cursor MCP configuration.`);
        }
    }

    // 6c. Configure Codex MCP
    if (shouldRun('codex')) {
        console.log(`${GREEN}[6c/14] Configuring Codex MCP...${NC}`);
        const codexCmd = getCliCommand('codex');
        const codexInstalled = spawnSync(codexCmd, ['--version'], { stdio: 'ignore' }).status === 0;
        if (codexInstalled) {
            try {
                console.log("  Registering AgenFK MCP server with Codex...");
                // Remove any existing registration first (ignore errors if not registered)
                spawnSync(codexCmd, ['mcp', 'remove', 'agenfk'], { stdio: 'ignore' });
                const result = spawnSync(codexCmd, [
                    'mcp', 'add',
                    '--env', `AGENFK_DB_PATH=${dbPath}`,
                    '--',
                    'agenfk',
                    'node', serverPath
                ], { stdio: 'inherit' });
                if (result.status === 0) {
                    console.log(`  ${GREEN}Registered agenfk MCP server with Codex.${NC}`);
                } else {
                    console.log(`  ${YELLOW}Warning: codex mcp add returned non-zero. Verify manually.${NC}`);
                }
            } catch (e) {
                console.error('  Error configuring Codex MCP:', e.message);
            }
        } else if (!onlyPlatform) {
            console.log(`  Codex not found. Skipping Codex MCP configuration.`);
        }
    }

    // 6d. Configure Gemini CLI MCP
    if (shouldRun('gemini')) {
        console.log(`${GREEN}[6d/14] Configuring Gemini CLI MCP...${NC}`);
        const geminiCmd = getCliCommand('gemini');
        const geminiInstalled = spawnSync(geminiCmd, ['--version'], { stdio: 'ignore' }).status === 0;
        if (geminiInstalled) {
            try {
                console.log("  Registering AgenFK MCP server with Gemini CLI...");
                // Remove any existing registration first (ignore errors if not registered)
                spawnSync(geminiCmd, ['mcp', 'remove', '-s', 'user', 'agenfk'], { stdio: 'ignore' });
                const result = spawnSync(geminiCmd, [
                    'mcp', 'add',
                    '-s', 'user',
                    '-e', `AGENFK_DB_PATH=${dbPath}`,
                    'agenfk',
                    'node', serverPath
                ], { stdio: 'inherit' });
                if (result.status === 0) {
                    console.log(`  ${GREEN}Registered agenfk MCP server with Gemini CLI.${NC}`);
                } else {
                    console.log(`  ${YELLOW}Warning: gemini mcp add returned non-zero. Verify manually.${NC}`);
                }
            } catch (e) {
                console.error('  Error configuring Gemini CLI MCP:', e.message);
            }
        } else if (!onlyPlatform) {
            console.log(`  Gemini CLI not found. Skipping Gemini CLI MCP configuration.`);
        }
    }

    // 7. Configure Claude Code MCP (deferred — runs after step 9 once cliDest is known)

    // 8. Install AgenFK Skills
    if (shouldRun('opencode')) {
        console.log(`${GREEN}[8/14] Installing agenfk skills (Opencode)...${NC}`);
        const skillsDir = path.join(os.homedir(), '.config', 'opencode', 'skills', 'agenfk');
        await fs.mkdir(skillsDir, { recursive: true });
        const skillSource = path.join(rootDir, 'SKILL.md');
        if (existsSync(skillSource)) {
            await fs.copyFile(skillSource, path.join(skillsDir, 'SKILL.md'));
            console.log(`Successfully installed agenfk skills to ${skillsDir}`);
        } else if (!onlyPlatform) {
            console.log(`SKILL.md not found in ${rootDir}. Skipping skills installation.`);
        }
    }

    // 8b. Install agenfk-flow skill for all platforms
    console.log(`${GREEN}[8b/14] Installing agenfk-flow skill...${NC}`);

    // Claude Code: ~/.claude/skills/agenfk-flow/SKILL.md
    if (shouldRun('claude')) {
        const claudeFlowSkillSource = path.join(rootDir, 'skills', 'claude-code', 'agenfk-flow', 'SKILL.md');
        if (existsSync(claudeFlowSkillSource)) {
            const claudeFlowSkillDir = path.join(os.homedir(), '.claude', 'skills', 'agenfk-flow');
            await fs.mkdir(claudeFlowSkillDir, { recursive: true });
            await fs.copyFile(claudeFlowSkillSource, path.join(claudeFlowSkillDir, 'SKILL.md'));
            console.log(`  Installed: ${path.join(claudeFlowSkillDir, 'SKILL.md')}`);
        } else if (!onlyPlatform) {
            console.log(`  ${YELLOW}Warning: skills/claude-code/agenfk-flow/SKILL.md not found. Skipping.${NC}`);
        }
    }

    // Opencode: ~/.config/opencode/skills/agenfk-flow/SKILL.md
    if (shouldRun('opencode')) {
        const opencodeFlowSkillSource = path.join(rootDir, 'skills', 'opencode', 'agenfk-flow', 'SKILL.md');
        if (existsSync(opencodeFlowSkillSource)) {
            const opencodeFlowSkillDir = path.join(os.homedir(), '.config', 'opencode', 'skills', 'agenfk-flow');
            await fs.mkdir(opencodeFlowSkillDir, { recursive: true });
            await fs.copyFile(opencodeFlowSkillSource, path.join(opencodeFlowSkillDir, 'SKILL.md'));
            console.log(`  Installed: ${path.join(opencodeFlowSkillDir, 'SKILL.md')}`);
        } else if (!onlyPlatform) {
            console.log(`  ${YELLOW}Warning: skills/opencode/agenfk-flow/SKILL.md not found. Skipping.${NC}`);
        }
    }

    // Cursor: ~/.cursor/rules/agenfk-flow.mdc (or platform-appropriate path)
    if (shouldRun('cursor')) {
        const cursorFlowSkillSource = path.join(rootDir, 'skills', 'cursor', 'agenfk-flow.mdc');
        if (existsSync(cursorFlowSkillSource)) {
            const cursorRulesDir = getCursorRulesDir();
            await fs.mkdir(cursorRulesDir, { recursive: true });
            await fs.copyFile(cursorFlowSkillSource, path.join(cursorRulesDir, 'agenfk-flow.mdc'));
            console.log(`  Installed: ${path.join(cursorRulesDir, 'agenfk-flow.mdc')}`);
        } else if (!onlyPlatform) {
            console.log(`  ${YELLOW}Warning: skills/cursor/agenfk-flow.mdc not found. Skipping.${NC}`);
        }
    }

    // Codex: ~/.codex/agenfk-flow.md
    if (shouldRun('codex')) {
        const codexFlowSkillSource = path.join(rootDir, 'skills', 'codex', 'agenfk-flow.md');
        if (existsSync(codexFlowSkillSource)) {
            const codexDir = path.join(os.homedir(), '.codex');
            await fs.mkdir(codexDir, { recursive: true });
            await fs.copyFile(codexFlowSkillSource, path.join(codexDir, 'agenfk-flow.md'));
            console.log(`  Installed: ${path.join(codexDir, 'agenfk-flow.md')}`);
        } else if (!onlyPlatform) {
            console.log(`  ${YELLOW}Warning: skills/codex/agenfk-flow.md not found. Skipping.${NC}`);
        }
    }

    // Gemini CLI: ~/.gemini/agenfk-flow.md
    if (shouldRun('gemini')) {
        const geminiFlowSkillSource = path.join(rootDir, 'skills', 'gemini', 'agenfk-flow.md');
        if (existsSync(geminiFlowSkillSource)) {
            const geminiDir = path.join(os.homedir(), '.gemini');
            await fs.mkdir(geminiDir, { recursive: true });
            await fs.copyFile(geminiFlowSkillSource, path.join(geminiDir, 'agenfk-flow.md'));
            console.log(`  Installed: ${path.join(geminiDir, 'agenfk-flow.md')}`);
        } else if (!onlyPlatform) {
            console.log(`  ${YELLOW}Warning: skills/gemini/agenfk-flow.md not found. Skipping.${NC}`);
        }
    }

    // 9. Symlink CLI to ~/.local/bin
    const localBinDir = path.join(os.homedir(), '.local', 'bin');
    const cliSource = path.join(rootDir, 'packages', 'cli', 'bin', 'agenfk.js');
    const cliDestBase = path.join(localBinDir, 'agenfk');
    const cliDest = os.platform() === 'win32' ? `${cliDestBase}.cmd` : cliDestBase;

    if (!onlyPlatform) {
        console.log(`${GREEN}[9/14] Installing agenfk command to ~/.local/bin...${NC}`);
        await fs.mkdir(localBinDir, { recursive: true });
        
        if (os.platform() === 'win32') {
            // Always write .cmd on Windows
            await fs.writeFile(`${cliDestBase}.cmd`, `@echo off\nnode "${cliSource}" %*`, 'utf8');
            // If MinGW, also write extension-less version for bash
            if (isMinGW) {
                await fs.writeFile(cliDestBase, `#!/bin/sh\nnode "${cliSource}" "$@"`, 'utf8');
                chmodSync(cliDestBase, 0o755);
            }
        } else {
            try {
                if (existsSync(cliDestBase)) await fs.unlink(cliDestBase);
                await fs.symlink(cliSource, cliDestBase);
                chmodSync(cliSource, 0o755);
            } catch (e) {
                await fs.copyFile(cliSource, cliDestBase);
                chmodSync(cliDestBase, 0o755);
            }
        }
        console.log(`  Installed: ${cliDestBase}${os.platform() === 'win32' ? '.cmd' : ''}`);

        // Ensure ~/.local/bin is on PATH in shell rc files (Linux/macOS only)
        if (os.platform() !== 'win32') {
            const pathDirs = (process.env.PATH || '').split(':');
            const alreadyOnPath = pathDirs.some(d => d === localBinDir || d === `${os.homedir()}/.local/bin`);
            if (!alreadyOnPath) {
                const exportLine = `\nexport PATH="$HOME/.local/bin:$PATH"`;
                const rcFiles = [
                    path.join(os.homedir(), '.zshrc'),
                    path.join(os.homedir(), '.bashrc'),
                    path.join(os.homedir(), '.profile'),
                ];
                for (const rc of rcFiles) {
                    try {
                        const existing = existsSync(rc) ? readFileSync(rc, 'utf8') : '';
                        if (!existing.includes('.local/bin')) {
                            await fs.appendFile(rc, exportLine, 'utf8');
                            console.log(`  Added ~/.local/bin to PATH in ${path.basename(rc)}`);
                        }
                    } catch { /* skip unwritable files */ }
                }
            }
            // Always show the source hint — even if ~/.local/bin is already in PATH,
            // the current shell session won't see the new symlink without a restart.
            const shell = path.basename(process.env.SHELL || '');
            const sourceHint = shell === 'zsh' ? 'source ~/.zshrc'
                : shell === 'bash' ? 'source ~/.bashrc'
                : shell === 'fish' ? 'source ~/.config/fish/config.fish'
                : 'source your shell rc file';
            console.log(`\n${YELLOW}  ⚠ Open a new terminal (or run: ${sourceHint}) for 'agenfk' to be available in your PATH.${NC}`);
        }
    }

    // 10 & 11. Global Slash Commands
    const integrations = [
        { name: 'Opencode', platform: 'opencode', targetBase: path.join(os.homedir(), '.config', 'opencode', 'commands') },
        { name: 'Claude Code', platform: 'claude', targetBase: path.join(os.homedir(), '.claude', 'commands') }
    ];

    for (const integration of integrations) {
        if (shouldRun(integration.platform)) {
            console.log(`${GREEN}[10-11/14] Installing global slash commands (${integration.name})...${NC}`);
            await fs.mkdir(integration.targetBase, { recursive: true });
            const commandsDir = path.join(rootDir, 'commands');
            if (existsSync(commandsDir)) {
                const files = await fs.readdir(commandsDir);
                for (const file of files) {
                    if (file.endsWith('.md')) {
                        await fs.copyFile(path.join(commandsDir, file), path.join(integration.targetBase, file));
                        console.log(`  Installed: ${path.join(integration.targetBase, file)}`);
                    }
                }
            }
        }
    }

    // 10c. Slash Commands — Gemini CLI (.toml wrappers referencing .md files)
    if (shouldRun('gemini')) {
        const geminiInstalled = spawnSync(getCliCommand('gemini'), ['--version'], { stdio: 'ignore' }).status === 0;
        if (geminiInstalled) {
            console.log(`${GREEN}[10c/14] Installing global slash commands (Gemini CLI)...${NC}`);
            const geminiCommandsBase = path.join(os.homedir(), '.gemini', 'commands');
            const geminiCommandsSubdir = path.join(geminiCommandsBase, 'agenfk');
            await fs.mkdir(geminiCommandsSubdir, { recursive: true });
            const commandsDir = path.join(rootDir, 'commands');
            if (existsSync(commandsDir)) {
                const files = await fs.readdir(commandsDir);
                for (const file of files) {
                    if (!file.endsWith('.md')) continue;
                    const mdPath = path.join(commandsDir, file);
                    const mdContent = readFileSync(mdPath, 'utf8');
                    // Parse description from YAML frontmatter
                    let description = file.replace('.md', '');
                    const fmMatch = mdContent.match(/^---\s*\n([\s\S]*?)\n---/);
                    if (fmMatch) {
                        const descMatch = fmMatch[1].match(/^description:\s*(.+)$/m);
                        if (descMatch) description = descMatch[1].trim();
                    }
                    const tomlContent = `description = "${description}"\nprompt = """\n@${mdPath}\n\nARGUMENTS: $ARGUMENTS\n"""\n`;
                    // agenfk.md → agenfk.toml (top-level), others → agenfk/<name>.toml
                    let tomlDest;
                    if (file === 'agenfk.md') {
                        tomlDest = path.join(geminiCommandsBase, 'agenfk.toml');
                    } else {
                        // agenfk-plan.md → plan.toml
                        const subName = file.replace(/^agenfk-/, '').replace('.md', '');
                        tomlDest = path.join(geminiCommandsSubdir, `${subName}.toml`);
                    }
                    writeFileSync(tomlDest, tomlContent, 'utf8');
                    console.log(`  Installed: ${tomlDest}`);
                }
            }
        } else if (!onlyPlatform) {
            console.log(`${GREEN}[10c/14] Gemini CLI not found. Skipping Gemini slash commands.${NC}`);
        }
    }

    // 12. Install gatekeeper hook script
    const gatekeeperSource = path.join(rootDir, 'bin', 'agenfk-gatekeeper.mjs');
    const gatekeeperDestBase = path.join(localBinDir, 'agenfk-gatekeeper');
    const gatekeeperDest = os.platform() === 'win32' ? `${gatekeeperDestBase}.cmd` : gatekeeperDestBase;

    if (!onlyPlatform) {
        console.log(`${GREEN}[12/14] Installing agenfk-gatekeeper hook script...${NC}`);
        if (os.platform() === 'win32') {
            // Always write .cmd on Windows
            await fs.writeFile(`${gatekeeperDestBase}.cmd`, `@echo off\nnode "${gatekeeperSource}" %*`, 'utf8');
            // If MinGW, also write extension-less version for bash
            if (isMinGW) {
                await fs.writeFile(gatekeeperDestBase, `#!/bin/sh\nnode "${gatekeeperSource}" "$@"`, 'utf8');
                chmodSync(gatekeeperDestBase, 0o755);
            }
        } else {
            if (existsSync(gatekeeperSource)) {
                await fs.copyFile(gatekeeperSource, gatekeeperDestBase);
                chmodSync(gatekeeperDestBase, 0o755);
            }
        }
        console.log(`  Installed: ${gatekeeperDestBase}${os.platform() === 'win32' ? '.cmd' : ''}`);

        // 12b. Install MCP enforcer hook script (blocks direct db/REST/CLI bypass routes)
        const enforcerSource = path.join(rootDir, 'bin', 'agenfk-mcp-enforcer.mjs');
        const enforcerDestBase = path.join(localBinDir, 'agenfk-mcp-enforcer');

        if (os.platform() === 'win32') {
            await fs.writeFile(`${enforcerDestBase}.cmd`, `@echo off\nnode "${enforcerSource}" %*`, 'utf8');
            if (isMinGW) {
                await fs.writeFile(enforcerDestBase, `#!/bin/sh\nnode "${enforcerSource}" "$@"`, 'utf8');
                chmodSync(enforcerDestBase, 0o755);
            }
        } else {
            if (existsSync(enforcerSource)) {
                await fs.copyFile(enforcerSource, enforcerDestBase);
                chmodSync(enforcerDestBase, 0o755);
            }
        }
        console.log(`  Installed: ${enforcerDestBase}${os.platform() === 'win32' ? '.cmd' : ''}`);
    }

    // 12c. Install Opencode MCP enforcer plugin
    if (shouldRun('opencode')) {
        const opencodePluginsDir = path.join(os.homedir(), '.config', 'opencode', 'plugins');
        const opencodeInstalled = spawnSync(getCliCommand('opencode'), ['--version'], { stdio: 'ignore' }).status === 0;
        if (existsSync(path.join(os.homedir(), '.config', 'opencode')) || opencodeInstalled) {
            await fs.mkdir(opencodePluginsDir, { recursive: true });
            const opencodeEnforcerSource = path.join(rootDir, 'bin', 'agenfk-mcp-enforcer-opencode.mjs');
            if (existsSync(opencodeEnforcerSource)) {
                await fs.copyFile(opencodeEnforcerSource, path.join(opencodePluginsDir, 'agenfk-mcp-enforcer.mjs'));
                console.log(`  Installed Opencode plugin: ${path.join(opencodePluginsDir, 'agenfk-mcp-enforcer.mjs')}`);
            }
        } else if (!onlyPlatform) {
            console.log(`  Opencode not found. Skipping Opencode plugin installation.`);
        }
    }

    const enforcerDestBase = path.join(localBinDir, 'agenfk-mcp-enforcer');
    const enforcerDest = os.platform() === 'win32' ? `${enforcerDestBase}.cmd` : enforcerDestBase;

    // 7 (deferred). Configure Claude Code MCP via official CLI
    if (shouldRun('claude')) {
        console.log(`${GREEN}[7/14] Configuring Claude Code MCP...${NC}`);
        try {
            const claudeCmd = getCliCommand('claude');
            const claudeCheck = spawnSync(claudeCmd, ['--version'], { stdio: 'ignore' });
            if (claudeCheck.status === 0) {
                console.log("  Registering AgenFK MCP server with Claude Code...");
                // Remove any existing registration first (ignore errors if not registered)
                spawnSync(claudeCmd, ['mcp', 'remove', 'agenfk'], { stdio: 'ignore' });
                // Register with correct syntax: options, then -- to end variadic -e, then name + command
                const result = spawnSync(claudeCmd, [
                    'mcp', 'add',
                    '--transport', 'stdio',
                    '--scope', 'user',
                    '-e', `AGENFK_DB_PATH=${dbPath}`,
                    '--',
                    'agenfk',
                    cliDest, 'mcp'
                ], { stdio: 'inherit' });
                if (result.status === 0) {
                    console.log(`  ${GREEN}Registered agenfk MCP server (user scope).${NC}`);
                } else {
                    console.log(`  ${YELLOW}Warning: claude mcp add returned non-zero. Verify with: claude mcp get agenfk${NC}`);
                }
            } else if (!onlyPlatform) {
                console.log("  Claude Code CLI not found. Skipping Claude MCP configuration.");
            }
        } catch (e) {
            console.log("  Error checking Claude Code CLI. Skipping.");
        }
    }

    // 13. Write AgenFK workflow rules to ~/.claude/CLAUDE.md
    if (shouldRun('claude')) {
        console.log(`${GREEN}[13/14] Writing AgenFK workflow rules to ~/.claude/CLAUDE.md...${NC}`);
        const claudeMdPath = path.join(os.homedir(), '.claude', 'CLAUDE.md');
        await fs.mkdir(path.dirname(claudeMdPath), { recursive: true });
        const claudeRulesSource = path.join(rootDir, 'clauderules', 'CLAUDE.md');

        if (existsSync(claudeRulesSource)) {
            const rulesContent = await fs.readFile(claudeRulesSource, 'utf8');

            let existingContent = '';
            if (existsSync(claudeMdPath)) {
                existingContent = await fs.readFile(claudeMdPath, 'utf8');
                // Remove any existing AgenFK block
                existingContent = existingContent.replace(/\n?<!-- agenfk:start -->[\s\S]*?<!-- agenfk:end -->\n?/g, '');
            }

            await fs.writeFile(
                claudeMdPath,
                (existingContent.trim() + '\n\n' + rulesContent.trim() + '\n').trim() + '\n',
                'utf8'
            );
            console.log(`  Written: ${claudeMdPath}`);
        } else if (!onlyPlatform) {
            console.log(`  ${YELLOW}Warning: clauderules/CLAUDE.md not found in framework root. Skipping.${NC}`);
        }
    }

    // 13b. Install Cursor workflow rules (.mdc)
    if (shouldRun('cursor')) {
        console.log(`${GREEN}[13b/14] Installing Cursor workflow rules (agenfk.mdc)...${NC}`);
        const cursorCmd = getCliCommand('cursor');
        const cursorMcpPath = getCursorMcpPath();
        const cursorConfigDir = path.dirname(cursorMcpPath);
        const cursorInstalled = existsSync(cursorConfigDir) ||
            spawnSync(cursorCmd, ['--version'], { stdio: 'ignore' }).status === 0;
        if (cursorInstalled) {
            try {
                const cursorRulesDir = getCursorRulesDir();
                await fs.mkdir(cursorRulesDir, { recursive: true });
                const mdcSource = path.join(rootDir, 'cursorrules', 'agenfk.mdc');
                if (existsSync(mdcSource)) {
                    await fs.copyFile(mdcSource, path.join(cursorRulesDir, 'agenfk.mdc'));
                    console.log(`  Written: ${path.join(cursorRulesDir, 'agenfk.mdc')}`);
                } else if (!onlyPlatform) {
                    console.log(`  ${YELLOW}Warning: cursorrules/agenfk.mdc not found in framework root. Skipping.${NC}`);
                }
            } catch (e) {
                console.error('  Error installing Cursor rules:', e.message);
            }
        } else if (!onlyPlatform) {
            console.log(`  Cursor not found. Skipping Cursor rules installation.`);
        }
    }

    // 13c. Install Codex workflow rules (AGENTS.md)
    if (shouldRun('codex')) {
        console.log(`${GREEN}[13c/14] Installing Codex workflow rules (AGENTS.md)...${NC}`);
        const codexCmd = getCliCommand('codex');
        const codexInstalled = spawnSync(codexCmd, ['--version'], { stdio: 'ignore' }).status === 0;
        if (codexInstalled) {
            try {
                const codexDir = path.join(os.homedir(), '.codex');
                await fs.mkdir(codexDir, { recursive: true });
                const codexAgentsMdPath = path.join(codexDir, 'AGENTS.md');
                const codexRulesSource = path.join(rootDir, 'codexrules', 'AGENTS.md');

                if (existsSync(codexRulesSource)) {
                    const rulesContent = await fs.readFile(codexRulesSource, 'utf8');

                    let existingContent = '';
                    if (existsSync(codexAgentsMdPath)) {
                        existingContent = await fs.readFile(codexAgentsMdPath, 'utf8');
                        // Remove any existing AgenFK block
                        existingContent = existingContent.replace(/\n?<!-- agenfk:start -->[\s\S]*?<!-- agenfk:end -->\n?/g, '');
                    }

                    await fs.writeFile(
                        codexAgentsMdPath,
                        (existingContent.trim() + '\n\n' + rulesContent.trim() + '\n').trim() + '\n',
                        'utf8'
                    );
                    console.log(`  Written: ${codexAgentsMdPath}`);
                } else if (!onlyPlatform) {
                    console.log(`  ${YELLOW}Warning: codexrules/AGENTS.md not found in framework root. Skipping.${NC}`);
                }
            } catch (e) {
                console.error('  Error installing Codex rules:', e.message);
            }
        } else if (!onlyPlatform) {
            console.log(`  Codex not found. Skipping Codex rules installation.`);
        }
    }

    // 13d. Install Gemini CLI workflow rules (GEMINI.md)
    if (shouldRun('gemini')) {
        console.log(`${GREEN}[13d/14] Installing Gemini CLI workflow rules (GEMINI.md)...${NC}`);
        const geminiCmd = getCliCommand('gemini');
        const geminiInstalled = spawnSync(geminiCmd, ['--version'], { stdio: 'ignore' }).status === 0;
        if (geminiInstalled) {
            try {
                const geminiDir = path.join(os.homedir(), '.gemini');
                await fs.mkdir(geminiDir, { recursive: true });
                const geminiMdPath = path.join(geminiDir, 'GEMINI.md');
                const geminiRulesSource = path.join(rootDir, 'geminirules', 'GEMINI.md');

                if (existsSync(geminiRulesSource)) {
                    const rulesContent = await fs.readFile(geminiRulesSource, 'utf8');

                    let existingContent = '';
                    if (existsSync(geminiMdPath)) {
                        existingContent = await fs.readFile(geminiMdPath, 'utf8');
                        // Remove any existing AgenFK block
                        existingContent = existingContent.replace(/\n?<!-- agenfk:start -->[\s\S]*?<!-- agenfk:end -->\n?/g, '');
                    }

                    await fs.writeFile(
                        geminiMdPath,
                        (existingContent.trim() + '\n\n' + rulesContent.trim() + '\n').trim() + '\n',
                        'utf8'
                    );
                    console.log(`  Written: ${geminiMdPath}`);
                } else if (!onlyPlatform) {
                    console.log(`  ${YELLOW}Warning: geminirules/GEMINI.md not found in framework root. Skipping.${NC}`);
                }
            } catch (e) {
                console.error('  Error installing Gemini CLI rules:', e.message);
            }
        } else if (!onlyPlatform) {
            console.log(`  Gemini CLI not found. Skipping Gemini CLI rules installation.`);
        }
    }

    // 14. Register PreToolUse hook and MCP server in ~/.claude/settings.json
    if (shouldRun('claude')) {
        console.log(`${GREEN}[14/14] Configuring ~/.claude/settings.json...${NC}`);
        const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
        let settings = {};
        if (existsSync(settingsPath)) {
            try {
                settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
            } catch (e) {}
        }
        
        // 12a. PreToolUse hook
        if (!settings.hooks) settings.hooks = {};
        if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];
        
        settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter(entry =>
            !JSON.stringify(entry).includes('agenfk-gatekeeper') &&
            !JSON.stringify(entry).includes('agenfk-mcp-enforcer')
        );

        settings.hooks.PreToolUse.push({
            matcher: 'Edit|Write|NotebookEdit',
            hooks: [{ type: 'command', command: gatekeeperDest }]
        });

        settings.hooks.PreToolUse.push({
            matcher: 'Bash|Read',
            hooks: [{ type: 'command', command: enforcerDest }]
        });

        // Remove legacy mcpServers key if present (MCP is now registered via `claude mcp add`)
        delete settings.mcpServers;

        await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
        console.log(`  Registered PreToolUse hooks in ${settingsPath}`);
    }

    if (!onlyPlatform) {
        console.log(`${GREEN}Installation Complete.${NC}`);
        console.log("");
        console.log(`${YELLOW}=== Telemetry Notice ===${NC}`);
        console.log("AgenFK collects anonymous usage data (install count, commands used, feature adoption).");
        console.log("No personal data, file paths, or project content is ever collected.");
        console.log(`To opt out at any time: ${BLUE}agenfk config set telemetry false${NC}`);
        console.log("");
        console.log(`${BLUE}=== Usage Instructions ===${NC}`);
        console.log("1. Restart your AI editor/agent (Opencode, Cursor, Codex, and Gemini CLI need a restart to pick up the new MCP server).");
        console.log("2. Run 'node scripts/start-services.mjs' to start the API and Web UI.");
        console.log("3. Go to ANY project repository and type '/agenfk' (Standard) or '/agenfk-deep' (Multi-Agent) in your AI editor's prompt to initialize your project context and start the workflow.");
        console.log("4. Use '/agenfk-release' or '/agenfk-release-beta' to push to remote and cut a release.");
        console.log("5. Phase Commands (Agent Spawn): '/agenfk-plan', '/agenfk-code', '/agenfk-review', '/agenfk-test', '/agenfk-close'.");
        console.log("6. Run 'agenfk health' to verify your installation at any time.");
    } else {
        console.log(`${GREEN}Integration '${onlyPlatform}' Installation Complete.${NC}`);
        console.log(`Restart ${onlyPlatform} to pick up the changes.`);
    }
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
