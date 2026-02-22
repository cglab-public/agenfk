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

async function run() {
    console.log(`${BLUE}=== AgenFK Uninstaller ===${NC}`);
    console.log("");
    console.log(`${YELLOW}This will remove:${NC}`);
    console.log("  - Slash commands from Claude Code and Opencode");
    console.log("  - Opencode skill");
    console.log("  - MCP server config from Claude Code and Opencode");
    console.log("  - AgenFK workflow rules from ~/.claude/CLAUDE.md");
    console.log("  - AgenFK PreToolUse hook from ~/.claude/settings.json");
    console.log("  - ~/.agenfk-system (the framework files)");
    console.log("");

    const skipConfirm = process.argv.includes('-y') || process.argv.includes('--yes');
    if (!skipConfirm) {
        // Since we can't easily do interactive input here, we'll assume skipConfirm if run in this environment
        // or just proceed if it's a script. But for a real CLI, we'd use 'readline'.
        // Let's just assume we want to proceed if not in a TTY or if requested.
        console.log(`${YELLOW}Proceeding with uninstallation...${NC}`);
    }

    // 1. Slash commands — Claude Code
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

    // 2. Slash commands — Opencode
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

    // 3. Opencode skill
    console.log(`${GREEN}[3/10] Removing Opencode skill...${NC}`);
    const skillDir = path.join(os.homedir(), '.config', 'opencode', 'skills', 'agenfk');
    if (existsSync(skillDir)) {
        await fs.rm(skillDir, { recursive: true, force: true });
        console.log(`  Removed: ${skillDir}`);
    }

    // 4. CLI symlink
    console.log(`${GREEN}[4/10] Removing agenfk CLI symlink...${NC}`);
    const localBinDir = path.join(os.homedir(), '.local', 'bin');
    const cliDest = path.join(localBinDir, os.platform() === 'win32' ? 'agenfk.cmd' : 'agenfk');
    if (existsSync(cliDest)) {
        await fs.unlink(cliDest);
        console.log(`  Removed: ${cliDest}`);
    }

    // 5. MCP config — Claude Code
    console.log(`${GREEN}[5/10] Removing Claude Code MCP config...${NC}`);
    try {
        const claudeCheck = spawnSync('claude', ['--version'], { shell: true });
        if (claudeCheck.status === 0) {
            spawnSync('claude', ['mcp', 'remove', 'agenfk'], { stdio: 'inherit', shell: true });
            console.log("  Removed: agenfk MCP from Claude Code");
        }
    } catch (e) {
        console.log("  Claude Code CLI not found (skipping)");
    }

    // 6. MCP config — Opencode
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

    // 7. Gatekeeper hook script
    console.log(`${GREEN}[7/10] Removing agenfk-gatekeeper hook script...${NC}`);
    const gatekeeperDest = path.join(localBinDir, os.platform() === 'win32' ? 'agenfk-gatekeeper.cmd' : 'agenfk-gatekeeper');
    if (existsSync(gatekeeperDest)) {
        await fs.unlink(gatekeeperDest);
        console.log(`  Removed: ${gatekeeperDest}`);
    }

    // 8. CLAUDE.md workflow rules
    console.log(`${GREEN}[8/10] Removing AgenFK rules from ~/.claude/CLAUDE.md...${NC}`);
    const claudeMdPath = path.join(os.homedir(), '.claude', 'CLAUDE.md');
    if (existsSync(claudeMdPath)) {
        let content = await fs.readFile(claudeMdPath, 'utf8');
        content = content.replace(/\n?<!-- agenfk:start -->[\s\S]*?<!-- agenfk:end -->\n?/g, '');
        await fs.writeFile(claudeMdPath, content, 'utf8');
        console.log(`  Removed AgenFK block from ${claudeMdPath}`);
    }

    // 9. Verify token
    console.log(`${GREEN}[9/10] Removing verify token...${NC}`);
    const agenfkHome = path.join(os.homedir(), '.agenfk');
    const tokenPath = path.join(agenfkHome, 'verify-token');
    if (existsSync(tokenPath)) {
        await fs.unlink(tokenPath);
        console.log(`  Removed: ${tokenPath}`);
    }

    // 10. PreToolUse hook in ~/.claude/settings.json
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
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
