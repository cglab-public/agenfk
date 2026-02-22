import fs from 'fs/promises';
import { existsSync, chmodSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync, execSync } from 'child_process';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const GREEN = '\x1b[32m';
const BLUE = '\x1b[34m';
const YELLOW = '\x1b[33m';
const NC = '\x1b[0m';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const agenfkHome = path.join(os.homedir(), '.agenfk');

async function run() {
    console.log(`${BLUE}=== AgenFK Framework Installation ===${NC}`);

    // 1. Build the project
    console.log(`${GREEN}[1/12] Building project...${NC}`);
    spawnSync('npm', ['install'], { stdio: 'inherit', cwd: rootDir, shell: true });
    spawnSync('npm', ['run', 'build'], { stdio: 'inherit', cwd: rootDir, shell: true });

    // 2. Generate install-time secret verify token
    console.log(`${GREEN}[2/12] Generating secret verify token...${NC}`);
    if (!existsSync(agenfkHome)) {
        await fs.mkdir(agenfkHome, { recursive: true });
    }
    const tokenPath = path.join(agenfkHome, 'verify-token');
    const token = crypto.randomBytes(32).toString('hex');
    await fs.writeFile(tokenPath, token, 'utf8');
    chmodSync(tokenPath, 0o600);
    console.log(`  Generated: ${tokenPath}`);

    // 3. Ensure configuration exists
    console.log(`${GREEN}[3/12] Initializing configuration...${NC}`);
    const localConfigDir = path.join(rootDir, '.agenfk');
    if (!existsSync(localConfigDir)) {
        spawnSync('node', [path.join(rootDir, 'packages/cli/bin/agenfk.js'), 'init'], { stdio: 'inherit', shell: true });
    }

    // 4. Create start script for UI/API
    console.log(`${GREEN}[4/12] Creating background service script (start-services.mjs)...${NC}`);
    const startScriptPath = path.join(rootDir, 'scripts', 'start-services.mjs');
    const dbPath = path.join(rootDir, '.agenfk', 'db.json');
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
        const match = content.match(/http:\\/\\/localhost:[0-9]+/);
        if (match) {
            uiUrl = match[0];
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

    // 5. Configure Opencode MCP
    console.log(`${GREEN}[5/12] Configuring Opencode MCP...${NC}`);
    const opencodeConfigPath = path.join(os.homedir(), '.config', 'opencode', 'opencode.json');
    if (existsSync(opencodeConfigPath)) {
        try {
            const config = JSON.parse(await fs.readFile(opencodeConfigPath, 'utf8'));
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
            console.log('Successfully updated opencode.json with agenfk MCP server.');
        } catch (e) {
            console.error('Error updating opencode.json:', e.message);
        }
    } else {
        console.log(`Opencode config not found at ${opencodeConfigPath}. Skipping.`);
    }

    // 5. Configure Claude Code MCP
    console.log(`${GREEN}[5/12] Configuring Claude Code MCP...${NC}`);
    try {
        const claudeCheck = spawnSync('claude', ['--version'], { shell: true });
        if (claudeCheck.status === 0) {
            console.log("Adding AgenFK MCP Server to Claude Code...");
            spawnSync('claude', ['mcp', 'add', 'agenfk', 'env', `AGENFK_DB_PATH=${dbPath}`, 'node', serverPath], { stdio: 'inherit', shell: true });
        } else {
            console.log("Claude Code CLI not found. Skipping Claude MCP configuration.");
        }
    } catch (e) {
        console.log("Error checking Claude Code CLI. Skipping.");
    }

    // 6. Install AgenFK Skills
    console.log(`${GREEN}[6/12] Installing agenfk skills (Opencode)...${NC}`);
    const skillsDir = path.join(os.homedir(), '.config', 'opencode', 'skills', 'agenfk');
    await fs.mkdir(skillsDir, { recursive: true });
    const skillSource = path.join(rootDir, 'SKILL.md');
    if (existsSync(skillSource)) {
        await fs.copyFile(skillSource, path.join(skillsDir, 'SKILL.md'));
        console.log(`Successfully installed agenfk skills to ${skillsDir}`);
    } else {
        console.log(`SKILL.md not found in ${rootDir}. Skipping skills installation.`);
    }

    // 7. Symlink CLI to ~/.local/bin
    console.log(`${GREEN}[7/12] Installing agenfk command to ~/.local/bin...${NC}`);
    const localBinDir = path.join(os.homedir(), '.local', 'bin');
    await fs.mkdir(localBinDir, { recursive: true });
    const cliSource = path.join(rootDir, 'packages', 'cli', 'bin', 'agenfk.js');
    const cliDest = path.join(localBinDir, os.platform() === 'win32' ? 'agenfk.cmd' : 'agenfk');
    
    if (os.platform() === 'win32') {
        await fs.writeFile(cliDest, `@echo off\nnode "${cliSource}" %*`, 'utf8');
    } else {
        try {
            if (existsSync(cliDest)) await fs.unlink(cliDest);
            await fs.symlink(cliSource, cliDest);
            chmodSync(cliSource, 0o755);
        } catch (e) {
            await fs.copyFile(cliSource, cliDest);
            chmodSync(cliDest, 0o755);
        }
    }
    console.log(`  Installed: ${cliDest}`);

    // 8 & 9. Global Slash Commands
    for (const [name, targetBase] of [['Opencode', path.join(os.homedir(), '.config', 'opencode', 'commands')], ['Claude Code', path.join(os.homedir(), '.claude', 'commands')]]) {
        console.log(`${GREEN}[8-9/12] Installing global slash commands (${name})...${NC}`);
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

    // 10. Install gatekeeper hook script
    console.log(`${GREEN}[10/12] Installing agenfk-gatekeeper hook script...${NC}`);
    const gatekeeperSource = path.join(rootDir, 'bin', 'agenfk-gatekeeper.mjs');
    const gatekeeperDest = path.join(localBinDir, os.platform() === 'win32' ? 'agenfk-gatekeeper.cmd' : 'agenfk-gatekeeper');
    
    if (os.platform() === 'win32') {
        await fs.writeFile(gatekeeperDest, `@echo off\nnode "${gatekeeperSource}" %*`, 'utf8');
    } else {
        if (existsSync(gatekeeperSource)) {
            await fs.copyFile(gatekeeperSource, gatekeeperDest);
            chmodSync(gatekeeperDest, 0o755);
        }
    }
    console.log(`  Installed: ${gatekeeperDest}`);

    // 11. Write AgenFK workflow rules to ~/.claude/CLAUDE.md
    console.log(`${GREEN}[11/12] Writing AgenFK workflow rules to ~/.claude/CLAUDE.md...${NC}`);
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

A PreToolUse hook enforces the IN_PROGRESS check mechanically.
<!-- agenfk:end -->
`;
    await fs.writeFile(claudeMdPath, (content.trim() + '\n\n' + rules.trim() + '\n').trim() + '\n', 'utf8');
    console.log(`  Written: ${claudeMdPath}`);

    // 12. Register PreToolUse hook in ~/.claude/settings.json
    console.log(`${GREEN}[12/12] Registering PreToolUse hook in ~/.claude/settings.json...${NC}`);
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    let settings = {};
    if (existsSync(settingsPath)) {
        try {
            settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
        } catch (e) {}
    }
    
    if (!settings.hooks) settings.hooks = {};
    if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];
    
    settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter(entry => 
        !JSON.stringify(entry).includes('agenfk-gatekeeper')
    );
    
    settings.hooks.PreToolUse.push({
        matcher: 'Edit|Write|NotebookEdit',
        hooks: [{ type: 'command', command: gatekeeperDest }]
    });
    
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    console.log(`  Registered PreToolUse hook in ${settingsPath}`);

    console.log(`${GREEN}Installation Complete.${NC}`);
    console.log("");
    console.log(`${BLUE}=== Usage Instructions ===${NC}`);
    console.log("1. Restart your AI editor/agent (Opencode needs a restart to pick up the new MCP).");
    console.log("2. Run 'node scripts/start-services.mjs' to start the API and Web UI.");
    console.log("3. Go to ANY project repository and type '/agenfk' in your AI editor's prompt to initialize your project context and start the workflow.");
    console.log("4. Use '/agenfk-release' or '/agenfk-release-beta' to push to remote and cut a release.");
    console.log("5. Phase Commands (Agent Spawn): '/agenfk-plan', '/agenfk-code', '/agenfk-review', '/agenfk-test', '/agenfk-close'.");
    console.log("6. Run 'agenfk health' to verify your installation at any time.");
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
