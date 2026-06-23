import fs from 'fs/promises';
import { existsSync } from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import {
    HOOK_VARIANTS,
    stripAgenfkHookEntries,
    resolveConfirmation,
    summarizeResults,
} from './uninstall-helpers.mjs';

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

function promptYesNo(question) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(question, (answer) => {
            rl.close();
            resolve(/^y(es)?$/i.test(answer.trim()));
        });
    });
}

// Remove a file or directory if present; returns true if something was removed.
async function rmIfExists(target) {
    if (!existsSync(target)) return false;
    await fs.rm(target, { recursive: true, force: true });
    return true;
}

// Strip AgenFK hook entries from a JSON config file. `paths` is a list of dotted
// key paths into the parsed object that each hold a hook array (e.g.
// 'hooks.PreToolUse', 'PostToolUse', 'afterShellExecution'). Returns true if the
// file changed. Non-AgenFK entries are preserved.
async function stripHooksFromJsonFile(filePath, hookArrayPaths) {
    if (!existsSync(filePath)) return false;
    let config;
    try {
        config = JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch {
        return false; // unreadable / not JSON — leave it alone
    }
    let changed = false;
    for (const dotted of hookArrayPaths) {
        const keys = dotted.split('.');
        let parent = config;
        for (let i = 0; i < keys.length - 1; i++) {
            parent = parent?.[keys[i]];
        }
        const leaf = keys[keys.length - 1];
        const arr = parent?.[leaf];
        if (Array.isArray(arr)) {
            const filtered = stripAgenfkHookEntries(arr);
            if (filtered.length !== arr.length) {
                parent[leaf] = filtered;
                changed = true;
            }
        }
    }
    if (changed) {
        await fs.writeFile(filePath, JSON.stringify(config, null, 2), 'utf8');
    }
    return changed;
}

async function run() {
    console.log(`${BLUE}=== AgenFK Uninstaller ===${NC}`);
    console.log("");
    const onlyPlatform = process.argv.find(arg => arg.startsWith('--only='))?.split('=')[1];
    const skipPlatform = process.argv.find(arg => arg.startsWith('--skip='))?.split('=')[1];
    const rulesScopeArg = process.argv.find(arg => arg.startsWith('--rules-scope='))?.split('=')[1];
    const rulesOnly = process.argv.includes('--rules-only');
    const projectDir = rulesOnly ? process.cwd() : rootDir;

    // Hoisted to function scope so every step can use it. Previously declared
    // inside the `if (!rulesOnly)` block, which made it undefined for the hook
    // removal step further down and crashed the uninstall mid-run (issue #88).
    const localBinDir = path.join(os.homedir(), '.local', 'bin');

    // Per-step results so a partial uninstall is reported instead of dying silently (#88).
    const results = [];
    async function step(label, enabled, fn) {
        if (enabled === false) {
            results.push({ label, status: 'skipped' });
            return;
        }
        try {
            const outcome = await fn();
            results.push({ label, status: outcome === false ? 'skipped' : 'removed' });
        } catch (e) {
            const msg = e?.message ?? String(e);
            results.push({ label, status: 'failed', error: msg });
            console.error(`  ${RED}Failed: ${label} — ${msg}${NC}`);
        }
    }

    function finish(headline) {
        const summary = summarizeResults(results);
        console.log("");
        console.log(`${headline}`);
        console.log(
            `  ${GREEN}removed: ${summary.removed}${NC}  ` +
            `${YELLOW}skipped: ${summary.skipped}${NC}  ` +
            `${summary.failed ? RED : GREEN}failed: ${summary.failed}${NC}`
        );
        if (summary.failed) {
            for (const f of summary.failures) {
                console.log(`  ${RED}- ${f.label}: ${f.error}${NC}`);
            }
        }
        process.exit(summary.exitCode);
    }

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
        console.log("  - Opencode skill + plugins (gatekeeper, mcp-enforcer, pr-hook)");
        console.log("  - MCP server config from Claude Code, Opencode, Cursor, Codex, Gemini CLI, and Pi");
        console.log("  - Cursor workflow rules (agenfk.mdc) + afterShellExecution hook");
        console.log("  - Codex workflow rules (~/.codex/AGENTS.md) + PostToolUse hook");
        console.log("  - Gemini CLI workflow rules (~/.gemini/GEMINI.md) + AfterTool hook");
        console.log("  - AgenFK workflow rules from ~/.claude/CLAUDE.md");
        console.log("  - AgenFK Pre/PostToolUse hooks from ~/.claude/settings.json");
        console.log("  - Hook scripts (gatekeeper, mcp-enforcer, pr-hook) from ~/.local/bin");
        console.log("  - ~/.agenfk (config + verify token) and ~/.agenfk-system (the framework files)");
        console.log("");
    }

    // Confirmation gate (#88 Bug 5): -y/--yes proceeds; an interactive TTY prompts;
    // a non-interactive run without -y aborts rather than assuming consent.
    const skipConfirm = process.argv.includes('-y') || process.argv.includes('--yes');
    const { proceed, shouldPrompt } = resolveConfirmation({ skipConfirm, isTTY: Boolean(process.stdin.isTTY) });
    if (!proceed) {
        if (shouldPrompt) {
            const ok = await promptYesNo(`${YELLOW}Proceed with uninstallation? [y/N] ${NC}`);
            if (!ok) {
                console.log(`${YELLOW}Aborted. Nothing was removed.${NC}`);
                process.exit(1);
            }
        } else {
            console.error(`${RED}Refusing to uninstall without confirmation.${NC}`);
            console.error(`Re-run with ${YELLOW}-y${NC} (or ${YELLOW}--yes${NC}) to proceed non-interactively.`);
            process.exit(1);
        }
    }

    // --rules-only: skip steps 1–6d, jump straight to rules removal
    if (rulesOnly) {
        console.log(`${BLUE}  --rules-only: removing workflow rules (${rulesScope} scope)...${NC}`);
    }

    if (!rulesOnly) {
    // 1. Slash commands — Claude Code
    await step('Claude Code slash commands', shouldRun('claude'), async () => {
        console.log(`${GREEN}[1] Removing Claude Code slash commands...${NC}`);
        const claudeCommandsDir = path.join(os.homedir(), '.claude', 'commands');
        let removed = false;
        if (existsSync(claudeCommandsDir)) {
            const files = await fs.readdir(claudeCommandsDir);
            for (const file of files) {
                if (file.startsWith('agenfk') && file.endsWith('.md')) {
                    await fs.unlink(path.join(claudeCommandsDir, file));
                    console.log(`  Removed: ${path.join(claudeCommandsDir, file)}`);
                    removed = true;
                }
            }
        }
        return removed;
    });

    // 2. Slash commands — Opencode
    await step('Opencode slash commands', shouldRun('opencode'), async () => {
        console.log(`${GREEN}[2] Removing Opencode slash commands...${NC}`);
        const opencodeCommandsDir = path.join(os.homedir(), '.config', 'opencode', 'commands');
        let removed = false;
        if (existsSync(opencodeCommandsDir)) {
            const files = await fs.readdir(opencodeCommandsDir);
            for (const file of files) {
                if (file.startsWith('agenfk') && file.endsWith('.md')) {
                    await fs.unlink(path.join(opencodeCommandsDir, file));
                    console.log(`  Removed: ${path.join(opencodeCommandsDir, file)}`);
                    removed = true;
                }
            }
        }
        return removed;
    });

    // 2b. Slash commands — Gemini CLI
    await step('Gemini CLI slash commands', shouldRun('gemini'), async () => {
        console.log(`${GREEN}[2b] Removing Gemini CLI slash commands...${NC}`);
        const geminiCommandsBase = path.join(os.homedir(), '.gemini', 'commands');
        let removed = false;
        removed = (await rmIfExists(path.join(geminiCommandsBase, 'agenfk.toml'))) || removed;
        removed = (await rmIfExists(path.join(geminiCommandsBase, 'agenfk'))) || removed;
        return removed;
    });

    // 3. Opencode skill (legacy single-dir format)
    await step('Opencode skill', shouldRun('opencode'), async () => {
        console.log(`${GREEN}[3] Removing Opencode skill...${NC}`);
        return rmIfExists(path.join(os.homedir(), '.config', 'opencode', 'skills', 'agenfk'));
    });

    // 3b. Skills (new skills/<name>/SKILL.md format).
    // When --only=<platform> is set, only remove that platform's skills dir.
    // The universal shared skills dir is only wiped on full uninstall (no --only flag).
    await step('agenfk skills', true, async () => {
        console.log(`${GREEN}[3b] Removing agenfk skills...${NC}`);
        const platformSkillsDirs = {
            claude: path.join(os.homedir(), '.claude', 'skills'),
            opencode: path.join(os.homedir(), '.config', 'opencode', 'skills'),
            cursor: path.join(os.homedir(), '.cursor', 'skills'),
            codex: path.join(os.homedir(), '.codex', 'skills'),
            gemini: path.join(os.homedir(), '.gemini', 'skills'),
        };
        const skillsDirs = onlyPlatform
            ? (platformSkillsDirs[onlyPlatform.toLowerCase()] ? [platformSkillsDirs[onlyPlatform.toLowerCase()]] : [])
            : [
                ...Object.values(platformSkillsDirs),
                path.join(os.homedir(), '.agents', 'skills'),
              ];
        let removed = false;
        for (const dir of skillsDirs) {
            if (!existsSync(dir)) continue;
            const entries = await fs.readdir(dir);
            for (const entry of entries) {
                if (entry.startsWith('agenfk')) {
                    await fs.rm(path.join(dir, entry), { recursive: true, force: true });
                    console.log(`  Removed: ${path.join(dir, entry)}`);
                    removed = true;
                }
            }
        }
        return removed;
    });

    // 4. CLI symlink + all hook scripts in ~/.local/bin (#88 Bug 2: was gatekeeper-only)
    await step('~/.local/bin scripts (agenfk CLI + hooks)', !onlyPlatform, async () => {
        console.log(`${GREEN}[4] Removing agenfk CLI symlink and hook scripts from ~/.local/bin...${NC}`);
        const suffix = os.platform() === 'win32' ? '.cmd' : '';
        let removed = false;
        for (const name of ['agenfk', ...HOOK_VARIANTS]) {
            const dest = path.join(localBinDir, `${name}${suffix}`);
            if (await rmIfExists(dest)) {
                console.log(`  Removed: ${dest}`);
                removed = true;
            }
        }
        return removed;
    });

    // 5. MCP config — Claude Code
    await step('Claude Code MCP config', shouldRun('claude'), async () => {
        console.log(`${GREEN}[5] Removing Claude Code MCP config...${NC}`);
        const claudeCmd = getCliCommand('claude');
        const claudeCheck = spawnSync(claudeCmd, ['--version'], { stdio: 'ignore' });
        if (claudeCheck.status === 0) {
            spawnSync(claudeCmd, ['mcp', 'remove', 'agenfk'], { stdio: 'inherit' });
            console.log("  Removed: agenfk MCP from Claude Code");
            return true;
        }
        console.log("  Claude Code CLI not found (skipping)");
        return false;
    });

    // 6. MCP config — Opencode
    await step('Opencode MCP config', shouldRun('opencode'), async () => {
        console.log(`${GREEN}[6] Removing Opencode MCP config...${NC}`);
        const opencodeConfigPath = path.join(os.homedir(), '.config', 'opencode', 'opencode.json');
        if (existsSync(opencodeConfigPath)) {
            const config = JSON.parse(await fs.readFile(opencodeConfigPath, 'utf8'));
            if (config.mcp && config.mcp.agenfk) {
                delete config.mcp.agenfk;
                await fs.writeFile(opencodeConfigPath, JSON.stringify(config, null, 2));
                console.log('  Removed: agenfk MCP from opencode.json');
                return true;
            }
            console.log('  Not found in opencode.json (skipping)');
        }
        return false;
    });

    // 6a. Opencode plugins (gatekeeper / mcp-enforcer / pr-hook) — #88 Bug 3
    await step('Opencode plugins', shouldRun('opencode'), async () => {
        console.log(`${GREEN}[6a] Removing Opencode plugins...${NC}`);
        const pluginsDir = path.join(os.homedir(), '.config', 'opencode', 'plugins');
        let removed = false;
        for (const variant of HOOK_VARIANTS) {
            const dest = path.join(pluginsDir, `${variant}.mjs`);
            if (await rmIfExists(dest)) {
                console.log(`  Removed: ${dest}`);
                removed = true;
            }
        }
        return removed;
    });

    // 6b. MCP config — Cursor
    await step('Cursor MCP config', shouldRun('cursor'), async () => {
        console.log(`${GREEN}[6b] Removing Cursor MCP config...${NC}`);
        const cursorMcpPath = getCursorMcpPath();
        if (existsSync(cursorMcpPath)) {
            const cursorMcp = JSON.parse(await fs.readFile(cursorMcpPath, 'utf8'));
            if (cursorMcp.mcpServers && cursorMcp.mcpServers.agenfk) {
                delete cursorMcp.mcpServers.agenfk;
                await fs.writeFile(cursorMcpPath, JSON.stringify(cursorMcp, null, 2));
                console.log(`  Removed: agenfk MCP from ${cursorMcpPath}`);
                return true;
            }
            console.log(`  Not found in ${cursorMcpPath} (skipping)`);
        } else {
            console.log(`  ${cursorMcpPath} not found (skipping)`);
        }
        return false;
    });

    // 6c. MCP config — Codex
    await step('Codex MCP config', shouldRun('codex'), async () => {
        console.log(`${GREEN}[6c] Removing Codex MCP config...${NC}`);
        const codexCmd = getCliCommand('codex');
        const codexCheck = spawnSync(codexCmd, ['--version'], { stdio: 'ignore' });
        if (codexCheck.status === 0) {
            spawnSync(codexCmd, ['mcp', 'remove', 'agenfk'], { stdio: 'inherit' });
            console.log("  Removed: agenfk MCP from Codex");
            return true;
        }
        console.log("  Codex CLI not found (skipping)");
        return false;
    });

    // 6d. MCP config — Gemini CLI
    await step('Gemini CLI MCP config', shouldRun('gemini'), async () => {
        console.log(`${GREEN}[6d] Removing Gemini CLI MCP config...${NC}`);
        const geminiCmd = getCliCommand('gemini');
        const geminiCheck = spawnSync(geminiCmd, ['--version'], { stdio: 'ignore' });
        if (geminiCheck.status === 0) {
            spawnSync(geminiCmd, ['mcp', 'remove', '-s', 'user', 'agenfk'], { stdio: 'inherit' });
            console.log("  Removed: agenfk MCP from Gemini CLI");
            return true;
        }
        console.log("  Gemini CLI not found (skipping)");
        return false;
    });

    // 6e. MCP config — Pi
    await step('Pi MCP config', shouldRun('pi'), async () => {
        console.log(`${GREEN}[6e] Removing Pi MCP config...${NC}`);
        const piMcpPath = path.join(os.homedir(), '.pi', 'agent', 'mcp.json');
        if (existsSync(piMcpPath)) {
            const piMcp = JSON.parse(await fs.readFile(piMcpPath, 'utf8'));
            if (piMcp.mcpServers && piMcp.mcpServers.agenfk) {
                delete piMcp.mcpServers.agenfk;
                await fs.writeFile(piMcpPath, JSON.stringify(piMcp, null, 2));
                console.log(`  Removed: agenfk MCP from ${piMcpPath}`);
                return true;
            }
            console.log(`  Not found in ${piMcpPath} (skipping)`);
        } else {
            console.log(`  ${piMcpPath} not found (skipping)`);
        }
        return false;
    });

    } // end if (!rulesOnly)

    // 6f. Codex workflow rules (AGENTS.md) — clean up from both scopes
    await step('Codex workflow rules (AGENTS.md)', shouldRun('codex'), async () => {
        console.log(`${GREEN}[6f] Removing Codex workflow rules (${rulesScope} scope)...${NC}`);
        const globalAgentsMd = path.join(os.homedir(), '.codex', 'AGENTS.md');
        const projectAgentsMd = path.join(projectDir, 'AGENTS.md');
        let removed = false;
        for (const agentsMdPath of [globalAgentsMd, projectAgentsMd]) {
            if (existsSync(agentsMdPath)) {
                const content = await fs.readFile(agentsMdPath, 'utf8');
                const cleaned = content.replace(/\n?<!-- agenfk:start -->[\s\S]*?<!-- agenfk:end -->\n?/g, '');
                if (cleaned !== content) {
                    if (cleaned.trim()) {
                        await fs.writeFile(agentsMdPath, cleaned, 'utf8');
                        console.log(`  Removed AgenFK block from ${agentsMdPath}`);
                    } else {
                        await fs.unlink(agentsMdPath);
                        console.log(`  Removed: ${agentsMdPath} (was AgenFK-only)`);
                    }
                    removed = true;
                }
            }
        }
        return removed;
    });

    // 6g. Cursor workflow rules (.mdc) — clean up from both scopes
    await step('Cursor workflow rules (.mdc)', shouldRun('cursor'), async () => {
        console.log(`${GREEN}[6g] Removing Cursor workflow rules (${rulesScope} scope)...${NC}`);
        const globalCursorMdc = path.join(getCursorRulesDir(), 'agenfk.mdc');
        const projectCursorMdc = path.join(projectDir, '.cursor', 'rules', 'agenfk.mdc');
        let removed = false;
        for (const mdcPath of [globalCursorMdc, projectCursorMdc]) {
            if (await rmIfExists(mdcPath)) {
                console.log(`  Removed: ${mdcPath}`);
                removed = true;
            }
        }
        return removed;
    });

    // 6h. Gemini CLI workflow rules (GEMINI.md) — clean up from both scopes
    await step('Gemini CLI workflow rules (GEMINI.md)', shouldRun('gemini'), async () => {
        console.log(`${GREEN}[6h] Removing Gemini CLI workflow rules (${rulesScope} scope)...${NC}`);
        const globalGeminiMd = path.join(os.homedir(), '.gemini', 'GEMINI.md');
        const projectGeminiMd = path.join(projectDir, 'GEMINI.md');
        let removed = false;
        for (const geminiMdPath of [globalGeminiMd, projectGeminiMd]) {
            if (existsSync(geminiMdPath)) {
                const content = await fs.readFile(geminiMdPath, 'utf8');
                const cleaned = content.replace(/\n?<!-- agenfk:start -->[\s\S]*?<!-- agenfk:end -->\n?/g, '');
                if (cleaned !== content) {
                    if (cleaned.trim()) {
                        await fs.writeFile(geminiMdPath, cleaned, 'utf8');
                        console.log(`  Removed AgenFK block from ${geminiMdPath}`);
                    } else {
                        await fs.unlink(geminiMdPath);
                        console.log(`  Removed: ${geminiMdPath} (was AgenFK-only)`);
                    }
                    removed = true;
                }
            }
        }
        return removed;
    });

    // 8. CLAUDE.md workflow rules (clean up from active scope + opposite)
    await step('AgenFK rules in CLAUDE.md', shouldRun('claude'), async () => {
        console.log(`${GREEN}[8] Removing AgenFK rules from CLAUDE.md (${rulesScope} scope)...${NC}`);
        const globalClaudeMd = path.join(os.homedir(), '.claude', 'CLAUDE.md');
        const projectClaudeMd = path.join(projectDir, '.claude', 'CLAUDE.md');
        let removed = false;
        for (const mdPath of [globalClaudeMd, projectClaudeMd]) {
            if (existsSync(mdPath)) {
                const content = await fs.readFile(mdPath, 'utf8');
                const cleaned = content.replace(/\n?<!-- agenfk:start -->[\s\S]*?<!-- agenfk:end -->\n?/g, '');
                if (cleaned !== content) {
                    await fs.writeFile(mdPath, cleaned, 'utf8');
                    console.log(`  Removed AgenFK block from ${mdPath}`);
                    removed = true;
                }
            }
        }
        return removed;
    });

    if (rulesOnly) {
        finish(`${GREEN}Done. Workflow rules removed (${rulesScope}).${NC}`);
        return;
    }

    // 9. ~/.agenfk data dir (config.json + verify-token) — #88 Bug 3 (was token-only)
    await step('~/.agenfk data dir', !onlyPlatform, async () => {
        console.log(`${GREEN}[9] Removing ~/.agenfk data dir...${NC}`);
        const removed = await rmIfExists(path.join(os.homedir(), '.agenfk'));
        if (removed) console.log(`  Removed: ${path.join(os.homedir(), '.agenfk')}`);
        return removed;
    });

    // 10. Pre/PostToolUse hooks in ~/.claude/settings.json — #88 Bug 2
    // Strip ALL hook variants from BOTH arrays (was: gatekeeper-only, PreToolUse-only).
    await step('Claude settings.json hooks', shouldRun('claude'), async () => {
        console.log(`${GREEN}[10] Removing Pre/PostToolUse hooks from ~/.claude/settings.json...${NC}`);
        const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
        const changed = await stripHooksFromJsonFile(settingsPath, ['hooks.PreToolUse', 'hooks.PostToolUse']);
        if (changed) console.log(`  Removed AgenFK hooks from ${settingsPath}`);
        return changed;
    });

    // 10b. Codex PostToolUse hook (~/.codex/hooks.json) — #88 Bug 3
    await step('Codex hooks.json pr-hook', shouldRun('codex'), async () => {
        console.log(`${GREEN}[10b] Removing PostToolUse hook from ~/.codex/hooks.json...${NC}`);
        const codexHooksPath = path.join(os.homedir(), '.codex', 'hooks.json');
        const changed = await stripHooksFromJsonFile(codexHooksPath, ['PostToolUse']);
        if (changed) console.log(`  Removed AgenFK hook from ${codexHooksPath}`);
        return changed;
    });

    // 10c. Gemini AfterTool hook (~/.gemini/settings.json) — #88 Bug 3
    await step('Gemini settings.json AfterTool hook', shouldRun('gemini'), async () => {
        console.log(`${GREEN}[10c] Removing AfterTool hook from ~/.gemini/settings.json...${NC}`);
        const geminiSettingsPath = path.join(os.homedir(), '.gemini', 'settings.json');
        const changed = await stripHooksFromJsonFile(geminiSettingsPath, ['hooks.AfterTool']);
        if (changed) console.log(`  Removed AgenFK hook from ${geminiSettingsPath}`);
        return changed;
    });

    // 10d. Cursor afterShellExecution hook (~/.cursor/hooks.json) — #88 Bug 3
    await step('Cursor hooks.json afterShellExecution', shouldRun('cursor'), async () => {
        console.log(`${GREEN}[10d] Removing afterShellExecution hook from ~/.cursor/hooks.json...${NC}`);
        const cursorHooksPath = path.join(os.homedir(), '.cursor', 'hooks.json');
        const changed = await stripHooksFromJsonFile(cursorHooksPath, ['afterShellExecution']);
        if (changed) console.log(`  Removed AgenFK hook from ${cursorHooksPath}`);
        return changed;
    });

    if (!onlyPlatform) {
        await step('~/.agenfk-system framework files', true, async () => {
            console.log("");
            console.log(`${RED}Removing ~/.agenfk-system...${NC}`);
            const systemDir = path.join(os.homedir(), '.agenfk-system');
            const removed = await rmIfExists(systemDir);
            if (removed) console.log(`  Removed: ${systemDir}`);
            return removed;
        });
        finish(`${GREEN}AgenFK uninstalled. Restart your AI editor to complete the removal.${NC}`);
    } else {
        finish(`${GREEN}Integration '${onlyPlatform}' uninstalled. Restart ${onlyPlatform} to complete the removal.${NC}`);
    }
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
