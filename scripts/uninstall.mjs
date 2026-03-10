import fs from 'fs/promises';
import { existsSync } from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync, execSync } from 'child_process';
import { fileURLToPath } from 'url';

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const BLUE = '\x1b[34m';
const YELLOW = '\x1b[33m';
const NC = '\x1b[0m';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

function getCliCommand(name) {
    return os.platform() === 'win32' ? `${name}.cmd` : name;
}

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

async function run() {
    console.log(`${BLUE}=== AgenFK Uninstaller ===${NC}`);
    console.log("");
    const onlyPlatform = process.argv.find(arg => arg.startsWith('--only='))?.split('=')[1];
    const skipPlatform = process.argv.find(arg => arg.startsWith('--skip='))?.split('=')[1];
    const rulesScopeArg = process.argv.find(arg => arg.startsWith('--rules-scope='))?.split('=')[1];
    const rulesOnly = process.argv.includes('--rules-only');
    const projectDir = rulesOnly ? process.cwd() : rootDir;

    // Read rulesScope from config to know where rules were installed
    let rulesScope = rulesScopeArg || '';
    const agenfkConfigPath = path.join(os.homedir(), '.agenfk', 'config.json');
    if (!rulesScope && existsSync(agenfkConfigPath)) {
        try {
            const cfg = JSON.parse(await fs.readFile(agenfkConfigPath, 'utf8'));
            if (cfg.rulesScope) rulesScope = cfg.rulesScope;
        } catch {}
    }
    if (!rulesScope) rulesScope = 'global';

    function shouldRun(platform) {
        if (onlyPlatform) return onlyPlatform.toLowerCase() === platform.toLowerCase();
        if (skipPlatform) return skipPlatform.toLowerCase() !== platform.toLowerCase();
        return true;
    }

    if (!onlyPlatform) {
        console.log(`${YELLOW}This will remove:${NC}`);
        console.log("  - Slash commands from Claude Code, Opencode, and Gemini CLI");
        console.log("  - Opencode skill");
        console.log("  - MCP server config from Claude Code, Opencode, Cursor, Codex, and Gemini CLI");
        console.log("  - Cursor workflow rules (agenfk.mdc)");
        console.log("  - Codex workflow rules (~/.codex/AGENTS.md)");
        console.log("  - Gemini CLI workflow rules (~/.gemini/GEMINI.md)");
        console.log("  - AgenFK workflow rules from ~/.claude/CLAUDE.md");
        console.log("  - AgenFK PreToolUse hook from ~/.claude/settings.json");
        console.log("  - ~/.agenfk-system (the framework files)");
        console.log("");
    }

    const skipConfirm = process.argv.includes('-y') || process.argv.includes('--yes');
    if (!skipConfirm) {
        // Since we can't easily do interactive input here, we'll assume skipConfirm if run in this environment
        // or just proceed if it's a script. But for a real CLI, we'd use 'readline'.
        // Let's just assume we want to proceed if not in a TTY or if requested.
        console.log(`${YELLOW}Proceeding with uninstallation...${NC}`);
    }

    // --rules-only: skip steps 1–6d, jump straight to rules removal
    if (rulesOnly) {
        console.log(`${BLUE}  --rules-only: removing workflow rules (${rulesScope} scope)...${NC}`);
    }

    if (!rulesOnly) {
    // 1. Slash commands — Claude Code
    if (shouldRun('claude')) {
        console.log(`${GREEN}[1/10] Removing Claude Code slash commands...${NC}`);
        const claudeCommandsDir = path.join(os.homedir(), '.claude', 'commands');
        if (existsSync(claudeCommandsDir)) {
            const files = await fs.readdir(claudeCommandsDir);
            for (const file of files) {
                if (file.startsWith('agenfk') && file.endsWith('.md')) {
                    const fullPath = path.join(claudeCommandsDir, file);
                    await fs.unlink(fullPath);
                    console.log(`  Removed: ${fullPath}`);
                }
            }
        }
    }

    // 2. Slash commands — Opencode
    if (shouldRun('opencode')) {
        console.log(`${GREEN}[2/10] Removing Opencode slash commands...${NC}`);
        const opencodeCommandsDir = path.join(os.homedir(), '.config', 'opencode', 'commands');
        if (existsSync(opencodeCommandsDir)) {
            const files = await fs.readdir(opencodeCommandsDir);
            for (const file of files) {
                if (file.startsWith('agenfk') && file.endsWith('.md')) {
                    const fullPath = path.join(opencodeCommandsDir, file);
                    await fs.unlink(fullPath);
                    console.log(`  Removed: ${fullPath}`);
                }
            }
        }
    }

    // 2b. Slash commands — Gemini CLI
    if (shouldRun('gemini')) {
        console.log(`${GREEN}[2b/10] Removing Gemini CLI slash commands...${NC}`);
        const geminiCommandsBase = path.join(os.homedir(), '.gemini', 'commands');
        const geminiAgenfkToml = path.join(geminiCommandsBase, 'agenfk.toml');
        if (existsSync(geminiAgenfkToml)) {
            await fs.unlink(geminiAgenfkToml);
            console.log(`  Removed: ${geminiAgenfkToml}`);
        }
        const geminiAgenfkSubdir = path.join(geminiCommandsBase, 'agenfk');
        if (existsSync(geminiAgenfkSubdir)) {
            await fs.rm(geminiAgenfkSubdir, { recursive: true, force: true });
            console.log(`  Removed: ${geminiAgenfkSubdir}`);
        }
    }

    // 3. Opencode skill
    if (shouldRun('opencode')) {
        console.log(`${GREEN}[3/10] Removing Opencode skill...${NC}`);
        const skillDir = path.join(os.homedir(), '.config', 'opencode', 'skills', 'agenfk');
        if (existsSync(skillDir)) {
            await fs.rm(skillDir, { recursive: true, force: true });
            console.log(`  Removed: ${skillDir}`);
        }
    }

    // 4. CLI symlink
    const localBinDir = path.join(os.homedir(), '.local', 'bin');
    if (!onlyPlatform) {
        console.log(`${GREEN}[4/10] Removing agenfk CLI symlink...${NC}`);
        const cliDest = path.join(localBinDir, os.platform() === 'win32' ? 'agenfk.cmd' : 'agenfk');
        if (existsSync(cliDest)) {
            await fs.unlink(cliDest);
            console.log(`  Removed: ${cliDest}`);
        }
    }

    // 5. MCP config — Claude Code
    if (shouldRun('claude')) {
        console.log(`${GREEN}[5/10] Removing Claude Code MCP config...${NC}`);
        try {
            const claudeCmd = getCliCommand('claude');
            const claudeCheck = spawnSync(claudeCmd, ['--version'], { stdio: 'ignore' });
            if (claudeCheck.status === 0) {
                spawnSync(claudeCmd, ['mcp', 'remove', 'agenfk'], { stdio: 'inherit' });
                console.log("  Removed: agenfk MCP from Claude Code");
            }
        } catch (e) {
            console.log("  Claude Code CLI not found (skipping)");
        }
    }

    // 6. MCP config — Opencode
    if (shouldRun('opencode')) {
        console.log(`${GREEN}[6/10] Removing Opencode MCP config...${NC}`);
        const opencodeConfigPath = path.join(os.homedir(), '.config', 'opencode', 'opencode.json');
        if (existsSync(opencodeConfigPath)) {
            try {
                const config = JSON.parse(await fs.readFile(opencodeConfigPath, 'utf8'));
                if (config.mcp && config.mcp.agenfk) {
                    delete config.mcp.agenfk;
                    await fs.writeFile(opencodeConfigPath, JSON.stringify(config, null, 2));
                    console.log('  Removed: agenfk MCP from opencode.json');
                } else {
                    console.log('  Not found in opencode.json (skipping)');
                }
            } catch (e) {
                console.error('  Error updating opencode.json:', e.message);
            }
        }
    }

    // 6b. MCP config — Cursor
    if (shouldRun('cursor')) {
        console.log(`${GREEN}[6b/10] Removing Cursor MCP config...${NC}`);
        const cursorMcpPath = getCursorMcpPath();
        if (existsSync(cursorMcpPath)) {
            try {
                const cursorMcp = JSON.parse(await fs.readFile(cursorMcpPath, 'utf8'));
                if (cursorMcp.mcpServers && cursorMcp.mcpServers.agenfk) {
                    delete cursorMcp.mcpServers.agenfk;
                    await fs.writeFile(cursorMcpPath, JSON.stringify(cursorMcp, null, 2));
                    console.log(`  Removed: agenfk MCP from ${cursorMcpPath}`);
                } else {
                    console.log(`  Not found in ${cursorMcpPath} (skipping)`);
                }
            } catch (e) {
                console.error('  Error updating Cursor mcp.json:', e.message);
            }
        } else {
            console.log(`  ${cursorMcpPath} not found (skipping)`);
        }
    }

    // 6c. MCP config — Codex
    if (shouldRun('codex')) {
        console.log(`${GREEN}[6c/10] Removing Codex MCP config...${NC}`);
        try {
            const codexCmd = getCliCommand('codex');
            const codexCheck = spawnSync(codexCmd, ['--version'], { stdio: 'ignore' });
            if (codexCheck.status === 0) {
                spawnSync(codexCmd, ['mcp', 'remove', 'agenfk'], { stdio: 'inherit' });
                console.log("  Removed: agenfk MCP from Codex");
            } else {
                console.log("  Codex CLI not found (skipping)");
            }
        } catch (e) {
            console.log("  Codex CLI not found (skipping)");
        }
    }

    // 6d. MCP config — Gemini CLI
    if (shouldRun('gemini')) {
        console.log(`${GREEN}[6d/10] Removing Gemini CLI MCP config...${NC}`);
        try {
            const geminiCmd = getCliCommand('gemini');
            const geminiCheck = spawnSync(geminiCmd, ['--version'], { stdio: 'ignore' });
            if (geminiCheck.status === 0) {
                spawnSync(geminiCmd, ['mcp', 'remove', '-s', 'user', 'agenfk'], { stdio: 'inherit' });
                console.log("  Removed: agenfk MCP from Gemini CLI");
            } else {
                console.log("  Gemini CLI not found (skipping)");
            }
        } catch (e) {
            console.log("  Gemini CLI not found (skipping)");
        }
    }

    } // end if (!rulesOnly)

    // 6e. Codex workflow rules (AGENTS.md) — clean up from both scopes
    if (shouldRun('codex')) {
        console.log(`${GREEN}[6e/10] Removing Codex workflow rules (${rulesScope} scope)...${NC}`);
        const globalAgentsMd = path.join(os.homedir(), '.codex', 'AGENTS.md');
        const projectAgentsMd = path.join(projectDir, 'AGENTS.md');
        for (const agentsMdPath of [globalAgentsMd, projectAgentsMd]) {
            if (existsSync(agentsMdPath)) {
                let content = await fs.readFile(agentsMdPath, 'utf8');
                const cleaned = content.replace(/\n?<!-- agenfk:start -->[\s\S]*?<!-- agenfk:end -->\n?/g, '');
                if (cleaned !== content) {
                    if (cleaned.trim()) {
                        await fs.writeFile(agentsMdPath, cleaned, 'utf8');
                        console.log(`  Removed AgenFK block from ${agentsMdPath}`);
                    } else {
                        await fs.unlink(agentsMdPath);
                        console.log(`  Removed: ${agentsMdPath} (was AgenFK-only)`);
                    }
                }
            }
        }
    }

    // 6f. Cursor workflow rules (.mdc) — clean up from both scopes
    if (shouldRun('cursor')) {
        console.log(`${GREEN}[6f/10] Removing Cursor workflow rules (${rulesScope} scope)...${NC}`);
        const globalCursorMdc = path.join(getCursorRulesDir(), 'agenfk.mdc');
        const projectCursorMdc = path.join(projectDir, '.cursor', 'rules', 'agenfk.mdc');
        for (const mdcPath of [globalCursorMdc, projectCursorMdc]) {
            if (existsSync(mdcPath)) {
                await fs.unlink(mdcPath);
                console.log(`  Removed: ${mdcPath}`);
            }
        }
    }

    // 6g. Gemini CLI workflow rules (GEMINI.md) — clean up from both scopes
    if (shouldRun('gemini')) {
        console.log(`${GREEN}[6g/10] Removing Gemini CLI workflow rules (${rulesScope} scope)...${NC}`);
        const globalGeminiMd = path.join(os.homedir(), '.gemini', 'GEMINI.md');
        const projectGeminiMd = path.join(projectDir, 'GEMINI.md');
        for (const geminiMdPath of [globalGeminiMd, projectGeminiMd]) {
            if (existsSync(geminiMdPath)) {
                let content = await fs.readFile(geminiMdPath, 'utf8');
                const cleaned = content.replace(/\n?<!-- agenfk:start -->[\s\S]*?<!-- agenfk:end -->\n?/g, '');
                if (cleaned !== content) {
                    if (cleaned.trim()) {
                        await fs.writeFile(geminiMdPath, cleaned, 'utf8');
                        console.log(`  Removed AgenFK block from ${geminiMdPath}`);
                    } else {
                        await fs.unlink(geminiMdPath);
                        console.log(`  Removed: ${geminiMdPath} (was AgenFK-only)`);
                    }
                }
            }
        }
    }

    // 7. Gatekeeper hook script
    if (!onlyPlatform) {
        console.log(`${GREEN}[7/10] Removing agenfk-gatekeeper hook script...${NC}`);
        const gatekeeperDest = path.join(localBinDir, os.platform() === 'win32' ? 'agenfk-gatekeeper.cmd' : 'agenfk-gatekeeper');
        if (existsSync(gatekeeperDest)) {
            await fs.unlink(gatekeeperDest);
            console.log(`  Removed: ${gatekeeperDest}`);
        }
    }

    // 8. CLAUDE.md workflow rules (clean up from active scope + opposite)
    if (shouldRun('claude')) {
        console.log(`${GREEN}[8/10] Removing AgenFK rules from CLAUDE.md (${rulesScope} scope)...${NC}`);
        const globalClaudeMd = path.join(os.homedir(), '.claude', 'CLAUDE.md');
        const projectClaudeMd = path.join(projectDir, '.claude', 'CLAUDE.md');
        for (const mdPath of [globalClaudeMd, projectClaudeMd]) {
            if (existsSync(mdPath)) {
                let content = await fs.readFile(mdPath, 'utf8');
                const cleaned = content.replace(/\n?<!-- agenfk:start -->[\s\S]*?<!-- agenfk:end -->\n?/g, '');
                if (cleaned !== content) {
                    await fs.writeFile(mdPath, cleaned, 'utf8');
                    console.log(`  Removed AgenFK block from ${mdPath}`);
                }
            }
        }
    }

    if (rulesOnly) {
        console.log(`${GREEN}Done. Workflow rules removed (${rulesScope}).${NC}`);
        return;
    }

    // 9. Verify token
    if (!onlyPlatform) {
        console.log(`${GREEN}[9/10] Removing verify token...${NC}`);
        const agenfkHome = path.join(os.homedir(), '.agenfk');
        const tokenPath = path.join(agenfkHome, 'verify-token');
        if (existsSync(tokenPath)) {
            await fs.unlink(tokenPath);
            console.log(`  Removed: ${tokenPath}`);
        }
    }

    // 10. PreToolUse hook in ~/.claude/settings.json
    if (shouldRun('claude')) {
        console.log(`${GREEN}[10/10] Removing PreToolUse hook from ~/.claude/settings.json...${NC}`);
        const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
        if (existsSync(settingsPath)) {
            try {
                let settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
                if (settings.hooks && settings.hooks.PreToolUse) {
                    settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter(entry =>
                        !JSON.stringify(entry).includes('agenfk-gatekeeper')
                    );
                    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
                    console.log(`  Removed agenfk-gatekeeper hook from ${settingsPath}`);
                }
            } catch (e) {}
        }
    }

    if (!onlyPlatform) {
        console.log("");
        console.log(`${RED}Removing ~/.agenfk-system...${NC}`);
        const systemDir = path.join(os.homedir(), '.agenfk-system');
        if (existsSync(systemDir)) {
            await fs.rm(systemDir, { recursive: true, force: true });
            console.log(`  Removed: ${systemDir}`);
        }

        console.log("");
        console.log(`${GREEN}AgenFK uninstalled successfully.${NC}`);
        console.log("Restart your AI editor to complete the removal.");
    } else {
        console.log("");
        console.log(`${GREEN}Integration '${onlyPlatform}' uninstalled successfully.${NC}`);
        console.log(`Restart ${onlyPlatform} to complete the removal.`);
    }
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
