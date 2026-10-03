#!/usr/bin/env node
/**
 * AgenFK MCP Enforcer — PreToolUse hook for Claude Code
 *
 * Blocks the two routes around the AgEnFK server (the single owner of state):
 *   1. Direct database reads  — .agenfk/db.sqlite or .agenfk/db.json via Bash or Read
 *   2. Direct REST API calls  — curl/wget to localhost:3000 or 127.0.0.1:3000
 *
 * The `agenfk` CLI and the MCP tools are interchangeable ways in, so neither is
 * blocked (BUG ec325925: until then a February MCP-first rule refused CLI reads
 * whenever the MCP server was registered).
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

/** How to read state instead: the CLI first, MCP as its equivalent. */
const INSTEAD =
    '\n\nRead and change state through the agenfk CLI instead:\n' +
    '  agenfk list --project <id> --json  •  agenfk get <id> --json  •  agenfk create ...  •  agenfk update <id> ...  •  agenfk verify <id> ...\n' +
    '(or the equivalent mcp__agenfk__* tools, when installed with --with-mcp).';

function block(reason) {
    process.stdout.write(JSON.stringify({ decision: 'block', reason: reason + INSTEAD }));
    process.exit(0);
}

// `--client <name>` is still passed by the installers; nothing depends on it now.

const toolIntent = await getToolIntent();
if (!toolIntent) process.exit(0);

// Claude Code (and Codex) send the tool as `tool_name`; `tool` is kept for
// clients/tests that use the older shape. Reading only `tool` meant no rule
// ever fired under Claude Code.
const tool = toolIntent.tool_name || toolIntent.tool || '';
const input = toolIntent.tool_input || {};

// ── Bash tool checks ──────────────────────────────────────────────────────────
if (tool === 'Bash') {
    const command = input.command || '';

    // 1. Block direct database access (.agenfk/db.sqlite or .agenfk/db.json)
    if (/\.agenfk[/\\](db\.sqlite|db\.json)/.test(command)) {
        block(
            'AgenFK MCP ENFORCER: Direct database access is forbidden.\n\n' +
            'Do NOT read .agenfk/db.sqlite or .agenfk/db.json via Bash.'
        );
    }

    // 2. Block direct REST API calls to the AgenFK server
    if (/\b(curl|wget)\b[\s\S]*\b(localhost:3000|127\.0\.0\.1:3000)\b/.test(command)) {
        const cwd = process.env.PWD || process.cwd();
        if (isInsideAgenFKProjectDir(cwd)) {
            block(
                'AgenFK MCP ENFORCER: Direct REST API calls to the AgenFK server are forbidden.\n\n' +
                'Do NOT use curl/wget to http://localhost:3000.'
            );
        }
    }
}

// ── Read tool checks ──────────────────────────────────────────────────────────
if (tool === 'Read') {
    const filePath = input.file_path || '';

    if (/\.agenfk[/\\](db\.sqlite|db\.json)/.test(filePath)) {
        block(
            'AgenFK MCP ENFORCER: Direct reads of AgenFK database files are forbidden.\n\n' +
            'Do NOT read .agenfk/db.sqlite or .agenfk/db.json via the Read tool.'
        );
    }
}

process.exit(0);
