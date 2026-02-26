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

function block(reason) {
    process.stdout.write(JSON.stringify({ decision: 'block', reason }));
    process.exit(0);
}

const toolIntent = await getToolIntent();
if (!toolIntent) process.exit(0);

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

    // 3. Block agenfk CLI state query commands
    if (/\bagenfk\s+(list|status|get|show|board)\b/.test(command) ||
        /\bnpx\s+agenfk\s+(list|status|get|show|board)\b/.test(command)) {
        block(
            'AgenFK MCP ENFORCER: agenfk CLI state queries are forbidden.\n\n' +
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
