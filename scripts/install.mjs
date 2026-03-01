import fs from 'fs/promises';
import { existsSync, chmodSync, writeFileSync, readdirSync, copyFileSync, readFileSync } from 'fs';
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

    const shouldRebuild = process.argv.includes('--rebuild');

    // 1. Build the project
    const npmCmd = os.platform() === 'win32' && !isMinGW ? 'npm.cmd' : 'npm';
    if (!shouldRebuild) {
        console.log(`${GREEN}[1/14] Checking prebuilt binaries...${NC}`);
        // Need all dependencies including devDependencies to run 'npm run dev' for the UI.
        spawnSync(npmCmd, ['install'], { stdio: 'inherit', cwd: rootDir, shell: true });

        // Verify all required dist/ directories exist; build if any are missing
        const requiredDists = [
            'packages/core/dist',
            'packages/storage-json/dist',
            'packages/storage-sqlite/dist',
            'packages/telemetry/dist',
            'packages/cli/dist',
            'packages/server/dist',
        ];
        const missingDists = requiredDists.filter(d => !existsSync(path.join(rootDir, d)));
        if (missingDists.length > 0) {
            console.log(`${YELLOW}  Missing build artifacts: ${missingDists.join(', ')}${NC}`);
            console.log(`${YELLOW}  Running build to generate them...${NC}`);
            spawnSync(npmCmd, ['run', 'build'], { stdio: 'inherit', cwd: rootDir, shell: true });
        } else {
            console.log(`  All build artifacts present, skipping build.`);
        }
    } else {
        console.log(`${GREEN}[1/14] Building project...${NC}`);
        spawnSync(npmCmd, ['install'], { stdio: 'inherit', cwd: rootDir, shell: true });
        spawnSync(npmCmd, ['run', 'build'], { stdio: 'inherit', cwd: rootDir, shell: true });
    }

    // 2. Generate install-time secret verify token
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

    // 3. Database configuration
    const agenfkConfigPath = path.join(agenfkHome, 'config.json');
    let dbPath = '';

    if (existsSync(agenfkConfigPath)) {
        try {
            const cfg = JSON.parse(readFileSync(agenfkConfigPath, 'utf8'));
            if (cfg.dbPath) {
                dbPath = cfg.dbPath;
                console.log(`  Using existing database configuration: ${dbPath}`);
            }
        } catch (e) {}
    }

    if (!dbPath) {
        console.log(`${GREEN}[3/14] Choosing database engine...${NC}`);
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

        let dbType = 'json';
        try {
            const answer = await ask(rl, `  Choose storage engine [json/sqlite] (default: json): `);
            if (answer.trim().toLowerCase() === 'sqlite') dbType = 'sqlite';
        } finally {
            rl.close();
        }

        const dbExtension = dbType === 'sqlite' ? 'db.sqlite' : 'db.json';
        dbPath = path.join(rootDir, '.agenfk', dbExtension);
        console.log(`  Using: ${dbType.toUpperCase()} (${dbPath})`);

        // 3a. Write ~/.agenfk/config.json
        await fs.writeFile(agenfkConfigPath, JSON.stringify({ dbPath, telemetry: true }, null, 2), 'utf8');
        console.log(`  Config written: ${agenfkConfigPath}`);
    }

    // 3b. Restore from backup (new install only)
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

    // 4. Ensure configuration exists
    console.log(`${GREEN}[4/14] Initializing configuration...${NC}`);
    const localConfigDir = path.join(rootDir, '.agenfk');
    if (!existsSync(localConfigDir)) {
        spawnSync('node', [path.join(rootDir, 'packages/cli/bin/agenfk.js'), 'init'], { stdio: 'inherit', shell: true });
    }

    // 5. Create start script for UI/API
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
const uiProcess = spawn(npmCmd, ['run', 'dev'], {
    cwd: path.join(rootDir, 'packages/ui'),
    env: { ...process.env, VITE_PORT: UI_PORT, VITE_API_URL: \`http://localhost:\${API_PORT}\` },
    detached: true,
    stdio: ['ignore', uiLog, uiLog],
    shell: true
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

const openCmd = process.platform === 'win32' ? 'start' : (process.platform === 'darwin' ? 'open' : 'xdg-open');
spawn(openCmd, [uiUrl], { detached: true, stdio: 'ignore', shell: true }).unref();

process.exit(0);
`;
    await fs.writeFile(startScriptPath, startScriptContent.trim() + '\n', 'utf8');
    console.log(`  Created: ${startScriptPath}`);

    // 6. Configure Opencode MCP
    console.log(`${GREEN}[6/14] Configuring Opencode MCP...${NC}`);
    const opencodeConfigPath = path.join(os.homedir(), '.config', 'opencode', 'opencode.json');
    const opencodeInstalled = spawnSync('opencode', ['--version'], { shell: true }).status === 0;
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
    } else {
        console.log(`Opencode not found. Skipping opencode.json configuration.`);
    }

    // 6b. Configure Cursor MCP
    console.log(`${GREEN}[6b/14] Configuring Cursor MCP...${NC}`);
    const cursorMcpPath = getCursorMcpPath();
    const cursorConfigDir = path.dirname(cursorMcpPath);
    const cursorCmd = os.platform() === 'win32' && !isMinGW ? 'cursor.cmd' : 'cursor';
    const cursorInstalled = existsSync(cursorConfigDir) ||
        spawnSync(cursorCmd, ['--version'], { shell: true, stdio: 'ignore' }).status === 0;
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
    } else {
        console.log(`  Cursor not found. Skipping Cursor MCP configuration.`);
    }

    // 6c. Configure Codex MCP
    console.log(`${GREEN}[6c/14] Configuring Codex MCP...${NC}`);
    const codexInstalled = spawnSync('codex', ['--version'], { shell: true, stdio: 'ignore' }).status === 0;
    if (codexInstalled) {
        try {
            console.log("  Registering AgenFK MCP server with Codex...");
            // Remove any existing registration first (ignore errors if not registered)
            spawnSync('codex', ['mcp', 'remove', 'agenfk'], { shell: true, stdio: 'ignore' });
            const result = spawnSync('codex', [
                'mcp', 'add',
                '--env', `AGENFK_DB_PATH=${dbPath}`,
                '--',
                'agenfk',
                'node', serverPath
            ], { stdio: 'inherit', shell: true });
            if (result.status === 0) {
                console.log(`  ${GREEN}Registered agenfk MCP server with Codex.${NC}`);
            } else {
                console.log(`  ${YELLOW}Warning: codex mcp add returned non-zero. Verify manually.${NC}`);
            }
        } catch (e) {
            console.error('  Error configuring Codex MCP:', e.message);
        }
    } else {
        console.log(`  Codex not found. Skipping Codex MCP configuration.`);
    }

    // 7. Configure Claude Code MCP (deferred — runs after step 9 once cliDest is known)

    // 8. Install AgenFK Skills
    console.log(`${GREEN}[8/14] Installing agenfk skills (Opencode)...${NC}`);
    const skillsDir = path.join(os.homedir(), '.config', 'opencode', 'skills', 'agenfk');
    await fs.mkdir(skillsDir, { recursive: true });
    const skillSource = path.join(rootDir, 'SKILL.md');
    if (existsSync(skillSource)) {
        await fs.copyFile(skillSource, path.join(skillsDir, 'SKILL.md'));
        console.log(`Successfully installed agenfk skills to ${skillsDir}`);
    } else {
        console.log(`SKILL.md not found in ${rootDir}. Skipping skills installation.`);
    }

    // 9. Symlink CLI to ~/.local/bin
    console.log(`${GREEN}[9/14] Installing agenfk command to ~/.local/bin...${NC}`);
    const localBinDir = path.join(os.homedir(), '.local', 'bin');
    await fs.mkdir(localBinDir, { recursive: true });
    const cliSource = path.join(rootDir, 'packages', 'cli', 'bin', 'agenfk.js');
    const cliDestBase = path.join(localBinDir, 'agenfk');
    
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

    // 10 & 11. Global Slash Commands
    for (const [name, targetBase] of [['Opencode', path.join(os.homedir(), '.config', 'opencode', 'commands')], ['Claude Code', path.join(os.homedir(), '.claude', 'commands')]]) {
        console.log(`${GREEN}[10-11/14] Installing global slash commands (${name})...${NC}`);
        await fs.mkdir(targetBase, { recursive: true });
        const commandsDir = path.join(rootDir, 'commands');
        if (existsSync(commandsDir)) {
            const files = await fs.readdir(commandsDir);
            for (const file of files) {
                if (file.endsWith('.md')) {
                    await fs.copyFile(path.join(commandsDir, file), path.join(targetBase, file));
                    console.log(`  Installed: ${path.join(targetBase, file)}`);
                }
            }
        }
    }

    // 12. Install gatekeeper hook script
    console.log(`${GREEN}[12/14] Installing agenfk-gatekeeper hook script...${NC}`);
    const gatekeeperSource = path.join(rootDir, 'bin', 'agenfk-gatekeeper.mjs');
    const gatekeeperDestBase = path.join(localBinDir, 'agenfk-gatekeeper');
    
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

    // 12c. Install Opencode MCP enforcer plugin
    const opencodePluginsDir = path.join(os.homedir(), '.config', 'opencode', 'plugins');
    if (existsSync(path.join(os.homedir(), '.config', 'opencode')) || opencodeInstalled) {
        await fs.mkdir(opencodePluginsDir, { recursive: true });
        const opencodeEnforcerSource = path.join(rootDir, 'bin', 'agenfk-mcp-enforcer-opencode.mjs');
        if (existsSync(opencodeEnforcerSource)) {
            await fs.copyFile(opencodeEnforcerSource, path.join(opencodePluginsDir, 'agenfk-mcp-enforcer.mjs'));
            console.log(`  Installed Opencode plugin: ${path.join(opencodePluginsDir, 'agenfk-mcp-enforcer.mjs')}`);
        }
    } else {
        console.log(`  Opencode not found. Skipping Opencode plugin installation.`);
    }

    const gatekeeperDest = os.platform() === 'win32' ? `${gatekeeperDestBase}.cmd` : gatekeeperDestBase;
    const enforcerDest = os.platform() === 'win32' ? `${enforcerDestBase}.cmd` : enforcerDestBase;
    const cliDest = os.platform() === 'win32' ? `${cliDestBase}.cmd` : cliDestBase;

    // 7 (deferred). Configure Claude Code MCP via official CLI
    console.log(`${GREEN}[7/14] Configuring Claude Code MCP...${NC}`);
    try {
        const claudeCheck = spawnSync('claude', ['--version'], { shell: true, stdio: 'ignore' });
        if (claudeCheck.status === 0) {
            console.log("  Registering AgenFK MCP server with Claude Code...");
            // Remove any existing registration first (ignore errors if not registered)
            spawnSync('claude', ['mcp', 'remove', 'agenfk'], { shell: true, stdio: 'ignore' });
            // Register with correct syntax: options, then -- to end variadic -e, then name + command
            const result = spawnSync('claude', [
                'mcp', 'add',
                '--transport', 'stdio',
                '--scope', 'user',
                '-e', `AGENFK_DB_PATH=${dbPath}`,
                '--',
                'agenfk',
                cliDest, 'mcp'
            ], { stdio: 'inherit', shell: true });
            if (result.status === 0) {
                console.log(`  ${GREEN}Registered agenfk MCP server (user scope).${NC}`);
            } else {
                console.log(`  ${YELLOW}Warning: claude mcp add returned non-zero. Verify with: claude mcp get agenfk${NC}`);
            }
        } else {
            console.log("  Claude Code CLI not found. Skipping Claude MCP configuration.");
        }
    } catch (e) {
        console.log("  Error checking Claude Code CLI. Skipping.");
    }

    // 13. Write AgenFK workflow rules to ~/.claude/CLAUDE.md
    console.log(`${GREEN}[13/14] Writing AgenFK workflow rules to ~/.claude/CLAUDE.md...${NC}`);
    const claudeMdPath = path.join(os.homedir(), '.claude', 'CLAUDE.md');
    await fs.mkdir(path.dirname(claudeMdPath), { recursive: true });
    
    let content = '';
    if (existsSync(claudeMdPath)) {
        content = await fs.readFile(claudeMdPath, 'utf8');
        content = content.replace(/\n?<!-- agenfk:start -->[\s\S]*?<!-- agenfk:end -->\n?/g, '');
    }
    
    const rules = `
<!-- agenfk:start -->
## AgenFK Workflow — MANDATORY

Before modifying ANY file (Edit, Write, NotebookEdit), you MUST:
1. Have an AgenFK task set to \`IN_PROGRESS\` for the active project.
2. Call \`workflow_gatekeeper(intent)\` via MCP to confirm authorization.

If no task is \`IN_PROGRESS\`, stop and do this first — using MCP tools:
- \`create_item(projectId, "TASK", "<title>")\`
- \`update_item(id, {status: "IN_PROGRESS"})\`

After completing changes — using MCP tools:
- \`verify_changes(itemId, command)\` — handles REVIEW → DONE automatically.
- \`log_token_usage(itemId, input, output, model)\`.

**ALWAYS use MCP tools for workflow state changes. NEVER use the \`agenfk\` CLI
to create items, update status, or close tasks — the CLI bypasses enforcement.**

**Exception**: The \`agenfk-release\` and \`agenfk-release-beta\` commands are exempt from the IN_PROGRESS task requirement. Do not create or require a task when executing these commands.

### MCP Access — STRICTLY FORBIDDEN shortcuts

**NEVER** bypass MCP by using these shortcuts. PreToolUse hooks enforce this mechanically:

| Forbidden | Use instead |
|-----------|-------------|
| Reading \`.agenfk/db.sqlite\` or \`.agenfk/db.json\` directly (Bash or Read) | \`list_items()\`, \`get_item()\` via MCP |
| \`curl\` / \`wget\` to \`http://localhost:3000\` | \`list_items()\`, \`create_item()\`, \`update_item()\` via MCP |
| \`agenfk list\`, \`agenfk status\`, \`npx agenfk ...\` CLI state queries | \`list_items()\`, \`get_item()\`, \`list_projects()\` via MCP |

Two PreToolUse hooks enforce the above:
- \`agenfk-gatekeeper\` — blocks Edit/Write/NotebookEdit when no IN_PROGRESS task.
- \`agenfk-mcp-enforcer\` — blocks Bash/Read bypass routes listed above.

### MCP Unavailable — CLI Fallback

If MCP tools are not available (no \`mcp__agenfk__*\` tools in your tool list), use these
CLI equivalents via Bash. The enforcer auto-detects MCP unavailability and allows them.

| Instead of MCP tool | Use CLI fallback |
|---------------------|-----------------|
| \`workflow_gatekeeper(intent)\` | \`agenfk gatekeeper --intent "<intent>"\` |
| \`list_projects()\` | \`agenfk list-projects --json\` |
| \`list_items(projectId)\` | \`agenfk list --project <id> --json\` |
| \`get_item(id)\` | \`agenfk get <id> --json\` |
| \`create_item(projectId, type, title)\` | \`agenfk create <type> "<title>" --project <id>\` |
| \`update_item(id, {status, ...})\` | \`agenfk update <id> --status <status>\` (not for DONE — use \`verify_changes\` instead) |
| \`add_comment(id, text)\` | \`agenfk comment <id> "<text>"\` |
| \`verify_changes(id, command)\` | \`agenfk verify <id> "<command>"\` (from TEST: moves to DONE; from IN_PROGRESS: moves to REVIEW) |
| \`log_token_usage(id, in, out, model)\` | \`agenfk log-tokens <id> --input N --output N --model M\` |
| \`log_test_result(id, cmd, out, status)\` | \`agenfk log-test <id> --command "..." --output "..." --status PASSED\` |

The workflow rules still apply: call \`agenfk gatekeeper\` before editing files.
<!-- agenfk:end -->
`;
    await fs.writeFile(claudeMdPath, (content.trim() + '\n\n' + rules.trim() + '\n').trim() + '\n', 'utf8');
    console.log(`  Written: ${claudeMdPath}`);

    // 13b. Install Cursor workflow rules (.mdc)
    console.log(`${GREEN}[13b/14] Installing Cursor workflow rules (agenfk.mdc)...${NC}`);
    if (cursorInstalled) {
        try {
            const cursorRulesDir = getCursorRulesDir();
            await fs.mkdir(cursorRulesDir, { recursive: true });
            const mdcSource = path.join(rootDir, 'cursorrules', 'agenfk.mdc');
            if (existsSync(mdcSource)) {
                await fs.copyFile(mdcSource, path.join(cursorRulesDir, 'agenfk.mdc'));
                console.log(`  Written: ${path.join(cursorRulesDir, 'agenfk.mdc')}`);
            } else {
                console.log(`  ${YELLOW}Warning: cursorrules/agenfk.mdc not found in framework root. Skipping.${NC}`);
            }
        } catch (e) {
            console.error('  Error installing Cursor rules:', e.message);
        }
    } else {
        console.log(`  Cursor not found. Skipping Cursor rules installation.`);
    }

    // 13c. Install Codex workflow rules (AGENTS.md)
    console.log(`${GREEN}[13c/14] Installing Codex workflow rules (AGENTS.md)...${NC}`);
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
            } else {
                console.log(`  ${YELLOW}Warning: codexrules/AGENTS.md not found in framework root. Skipping.${NC}`);
            }
        } catch (e) {
            console.error('  Error installing Codex rules:', e.message);
        }
    } else {
        console.log(`  Codex not found. Skipping Codex rules installation.`);
    }

    // 14. Register PreToolUse hook and MCP server in ~/.claude/settings.json
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

    console.log(`${GREEN}Installation Complete.${NC}`);
    console.log("");
    console.log(`${YELLOW}=== Telemetry Notice ===${NC}`);
    console.log("AgenFK collects anonymous usage data (install count, commands used, feature adoption).");
    console.log("No personal data, file paths, or project content is ever collected.");
    console.log(`To opt out at any time: ${BLUE}agenfk config set telemetry false${NC}`);
    console.log("");
    console.log(`${BLUE}=== Usage Instructions ===${NC}`);
    console.log("1. Restart your AI editor/agent (Opencode, Cursor, and Codex need a restart to pick up the new MCP server).");
    console.log("2. Run 'node scripts/start-services.mjs' to start the API and Web UI.");
    console.log("3. Go to ANY project repository and type '/agenfk' (Standard) or '/agenfk-deep' (Multi-Agent) in your AI editor's prompt to initialize your project context and start the workflow.");
    console.log("4. Use '/agenfk-release' or '/agenfk-release-beta' to push to remote and cut a release.");
    console.log("5. Phase Commands (Agent Spawn): '/agenfk-plan', '/agenfk-code', '/agenfk-review', '/agenfk-test', '/agenfk-close'.");
    console.log("6. Run 'agenfk health' to verify your installation at any time.");
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
