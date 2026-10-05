/**
 * AgenFK MCP Enforcer — Opencode plugin (tool.execute.before hook)
 *
 * Blocks the two routes around the AgEnFK server (the single owner of state):
 *   1. Direct database reads  — .agenfk/db.sqlite or .agenfk/db.json via bash or read
 *   2. Direct REST API calls  — curl/wget to localhost:3000 or 127.0.0.1:3000
 *
 * The `agenfk` CLI and the MCP tools are interchangeable ways in, so neither is
 * blocked (BUG ec325925).
 *
 * Installed to ~/.config/opencode/plugins/ during agenfk install/upgrade.
 */

import fs from 'fs';
import path from 'path';

/** How to read state instead: the CLI first, MCP as its equivalent. */
const INSTEAD =
    '\nRead and change state through the agenfk CLI instead: agenfk list --project <id> --json • agenfk get <id> --json • ' +
    'agenfk create ... • agenfk update <id> ... • agenfk verify <id> ... (or the equivalent agenfk MCP tools, when installed with --with-mcp).';

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

export default async function agenfkMcpEnforcer(context) {
    return {
        'tool.execute.before': async (input) => {
            const tool = (input.tool || '').toLowerCase();
            const args = input.args || {};
            const cwd = context?.directory || process.cwd();

            // ── bash tool checks ────────────────────────────────────────────────
            if (tool === 'bash' || tool === 'execute') {
                const command = args.command || '';

                // 1. Block direct database access
                if (/\.agenfk[/\\](db\.sqlite|db\.json)/.test(command)) {
                    throw new Error(
                        'AgenFK MCP ENFORCER: Direct database access is forbidden.\n' +
                        'Do NOT read .agenfk/db.sqlite or .agenfk/db.json via Bash.' +
                        INSTEAD
                    );
                }

                // 2. Block direct REST API calls to the AgenFK server
                if (/\b(curl|wget)\b[\s\S]*\b(localhost:3000|127\.0\.0\.1:3000)\b/.test(command)) {
                    if (isInsideAgenFKProjectDir(cwd)) {
                        throw new Error(
                            'AgenFK MCP ENFORCER: Direct REST API calls to the AgenFK server are forbidden.\n' +
                            'Do NOT use curl/wget to http://localhost:3000.' +
                            INSTEAD
                        );
                    }
                }
            }

            // ── read tool checks ────────────────────────────────────────────────
            if (tool === 'read') {
                const filePath = args.filePath || args.file_path || '';

                if (/\.agenfk[/\\](db\.sqlite|db\.json)/.test(filePath)) {
                    throw new Error(
                        'AgenFK MCP ENFORCER: Direct reads of AgenFK database files are forbidden.\n' +
                        'Do NOT read .agenfk/db.sqlite or .agenfk/db.json.' +
                        INSTEAD
                    );
                }
            }
        }
    };
}
