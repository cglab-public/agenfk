#!/usr/bin/env node
/**
 * AgenFK MCP Enforcer — PreToolUse hook for Claude Code
 *
 * Blocks all three bypass routes that agents use instead of MCP tool calls:
 *   1. Direct database reads  — .agenfk/db.sqlite or .agenfk/db.json via Bash or Read
 *   2. Direct REST API calls  — curl/wget to localhost:3000 or 127.0.0.1:3000
 *   3. CLI state queries      — agenfk list/status/get/show, npx agenfk, etc.
 *
 * Registered in ~/.claude/settings.json as a PreToolUse hook with matcher: Bash|Read
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Check if the agenfk MCP server is both registered AND allowed by enterprise policy.
 * Returns false if the server is registered but blocked by allowedMcpServers policy,
 * which means CLI fallback commands should be allowed.
 */
function isMcpAvailable() {
    try {
        const homeDir = os.homedir();
        // Check if agenfk is registered in ~/.claude.json (user scope)
        const claudeJsonPath = path.join(homeDir, '.claude.json');
        if (!fs.existsSync(claudeJsonPath)) return false;
        const claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
        if (!claudeJson?.mcpServers?.agenfk) return false;
        // Check if enterprise policy blocks it (allowedMcpServers: [] means block all)
        const remoteSettingsPath = path.join(homeDir, '.claude', 'remote-settings.json');
        if (fs.existsSync(remoteSettingsPath)) {
            const remoteSettings = JSON.parse(fs.readFileSync(remoteSettingsPath, 'utf8'));
            const allowed = remoteSettings?.allowedMcpServers;
            if (Array.isArray(allowed) && allowed.length === 0) return false;
        }
        return true;
    } catch {
        return true; // Fail open: assume MCP is available if we can't determine
    }
}

async function getToolIntent() {
    return new Promise((resolve) => {
        let data = '';
        const timeout = setTimeout(() => resolve(null), 500);
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (chunk) => data += chunk);
        process.stdin.on('end', () => {
            clearTimeout(timeout);
            try {
                resolve(data.trim() ? JSON.parse(data) : null);
            } catch {
                resolve(null);
            }
        });
        process.stdin.on('close', () => {
            clearTimeout(timeout);
            resolve(null);
        });
    });
}

function isInsideAgenFKProjectDir(dirPath) {
    if (!dirPath) return false;
    let dir = dirPath;
    const root = path.parse(dir).root;
    while (dir !== root) {
        if (fs.existsSync(path.join(dir, '.agenfk', 'project.json'))) return true;
        dir = path.dirname(dir);
    }
    return false;
}

const FALLBACK_FLAG = path.join(
    process.env.HOME || process.env.USERPROFILE || '',
    '.agenfk', 'mcp-fallback-approved'
);
const FALLBACK_TTL_MS = 5 * 60 * 1000; // 5 minutes

function isFallbackApproved() {
    try {
        if (!fs.existsSync(FALLBACK_FLAG)) return false;
        const ageMs = Date.now() - fs.statSync(FALLBACK_FLAG).mtimeMs;
        if (ageMs < FALLBACK_TTL_MS) return true;
        fs.unlinkSync(FALLBACK_FLAG); // expired — clean up
        return false;
    } catch {
        return false;
    }
}

const FALLBACK_INSTRUCTIONS =
    '\n\nIf MCP tools are genuinely unavailable in this session:\n' +
    '  Use the agenfk CLI fallback commands instead:\n' +
    '    agenfk gatekeeper --intent "<intent>"   (replaces workflow_gatekeeper)\n' +
    '    agenfk list --json                       (replaces list_items)\n' +
    '    agenfk get <id> --json                   (replaces get_item)\n' +
    '    agenfk comment <id> "<text>"             (replaces add_comment)\n' +
    '    agenfk verify <id> "<command>"           (replaces verify_changes)\n' +
    '    agenfk log-tokens <id> --input N --output N --model M\n' +
    '  Or approve a temporary REST API fallback window:\n' +
    '    touch ~/.agenfk/mcp-fallback-approved    (expires after 5 minutes)';

function block(reason) {
    process.stdout.write(JSON.stringify({ decision: 'block', reason: reason + FALLBACK_INSTRUCTIONS }));
    process.exit(0);
}

const toolIntent = await getToolIntent();
if (!toolIntent) process.exit(0);

// If user has explicitly approved fallback, allow bypass for this window
if (isFallbackApproved()) process.exit(0);

const tool = toolIntent.tool || '';
const input = toolIntent.tool_input || {};

// ── Bash tool checks ──────────────────────────────────────────────────────────
if (tool === 'Bash') {
    const command = input.command || '';

    // 1. Block direct database access (.agenfk/db.sqlite or .agenfk/db.json)
    if (/\.agenfk[/\\](db\.sqlite|db\.json)/.test(command)) {
        block(
            'AgenFK MCP ENFORCER: Direct database access is forbidden.\n\n' +
            'Do NOT read .agenfk/db.sqlite or .agenfk/db.json via Bash.\n' +
            'Use MCP tool invocations instead:\n' +
            '  list_items(projectId)  •  get_item(id)  •  create_item(...)  •  update_item(...)'
        );
    }

    // 2. Block direct REST API calls to the AgenFK server
    if (/\b(curl|wget)\b[\s\S]*\b(localhost:3000|127\.0\.0\.1:3000)\b/.test(command)) {
        const cwd = process.env.PWD || process.cwd();
        if (isInsideAgenFKProjectDir(cwd)) {
            block(
                'AgenFK MCP ENFORCER: Direct REST API calls to the AgenFK server are forbidden.\n\n' +
                'Do NOT use curl/wget to http://localhost:3000.\n' +
                'Use MCP tool invocations instead:\n' +
                '  list_items(projectId)  •  create_item(...)  •  update_item(...)  •  verify_changes(...)'
            );
        }
    }

    // 3. Block agenfk CLI state query commands (only when MCP is available).
    // When MCP is policy-blocked, the CLI commands are the intended fallback.
    if (isMcpAvailable() &&
        (/\bagenfk\s+(list|status|get|show|board)\b/.test(command) ||
         /\bnpx\s+agenfk\s+(list|status|get|show|board)\b/.test(command))) {
        block(
            'AgenFK MCP ENFORCER: agenfk CLI state queries are forbidden while MCP is available.\n\n' +
            'Do NOT use: agenfk list, agenfk status, agenfk get, npx agenfk ...\n' +
            'Use MCP tool invocations instead:\n' +
            '  list_items(projectId)  •  get_item(id)  •  list_projects()'
        );
    }
}

// ── Read tool checks ──────────────────────────────────────────────────────────
if (tool === 'Read') {
    const filePath = input.file_path || '';

    if (/\.agenfk[/\\](db\.sqlite|db\.json)/.test(filePath)) {
        block(
            'AgenFK MCP ENFORCER: Direct reads of AgenFK database files are forbidden.\n\n' +
            'Do NOT read .agenfk/db.sqlite or .agenfk/db.json via the Read tool.\n' +
            'Use MCP tool invocations instead:\n' +
            '  list_items(projectId)  •  get_item(id)  •  create_item(...)  •  update_item(...)'
        );
    }
}

process.exit(0);
